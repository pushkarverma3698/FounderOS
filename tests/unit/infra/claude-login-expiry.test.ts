/**
 * The founder is told 3 days before the server's saved Claude login stops renewing (C-P0-5), once per expiry window.
 * Claude only: Google exposes no expiry, so there is nothing to warn about there.
 * Fixture dates and in-memory deps: $0, offline, no database.
 */

import { describe, it, expect, vi } from "vitest";
import { checkClaudeLoginExpiry, CLAUDE_EXPIRY_CRON, type ExpiryDeps } from "../../../src/infra/claude-login-expiry.js";
import type { HostExpiryRead } from "../../../src/infra/claude-token.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-05T10:15:00Z");

function setup(read: HostExpiryRead) {
  const audited = new Set<string>();
  const sent: string[] = [];
  const deps: ExpiryDeps = {
    read: async () => read,
    now: () => NOW,
    send: vi.fn(async (text: string) => void sent.push(text)),
    hasBeenAudited: async (key) => audited.has(key),
    writeAuditEntry: vi.fn(async (row: { idempotency_key?: string | null }) => {
      audited.add(row.idempotency_key ?? "");
      return { written: true };
    }),
  };
  return { deps, sent, audited };
}

const expiresIn = (ms: number): HostExpiryRead => ({ state: "ok", expiresAtMs: NOW + ms });

describe("checkClaudeLoginExpiry", () => {
  it("does not warn 4 days ahead", async () => {
    const { deps, sent } = setup(expiresIn(4 * DAY));
    expect(await checkClaudeLoginExpiry(deps)).toBe("not-due");
    expect(sent).toEqual([]);
  });

  it("warns 3 days ahead, names /login claude and the date", async () => {
    const { deps, sent } = setup(expiresIn(3 * DAY));
    expect(await checkClaudeLoginExpiry(deps)).toBe("warned");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("/login claude");
    expect(sent[0]).toContain("2026-10-08");
  });

  it("warns inside the window too (a restart or a missed tick must not skip it)", async () => {
    const { deps, sent } = setup(expiresIn(DAY + 5 * 60_000));
    expect(await checkClaudeLoginExpiry(deps)).toBe("warned");
    expect(sent[0]).toMatch(/2 days/);
  });

  it("does not warn twice for the same expiry", async () => {
    const { deps, sent } = setup(expiresIn(2 * DAY));
    expect(await checkClaudeLoginExpiry(deps)).toBe("warned");
    expect(await checkClaudeLoginExpiry(deps)).toBe("already-warned");
    expect(sent).toHaveLength(1);
  });

  it("warns again for a new expiry window (the login was renewed, then ran down again)", async () => {
    const first = setup(expiresIn(2 * DAY));
    await checkClaudeLoginExpiry(first.deps);
    const second: ExpiryDeps = { ...first.deps, read: async () => ({ state: "ok", expiresAtMs: NOW + 400 * DAY }), now: () => NOW + 398 * DAY };
    expect(await checkClaudeLoginExpiry(second)).toBe("warned");
    expect(first.sent).toHaveLength(2);
  });

  it("records the window durably, keyed on the expiry timestamp, with no token in it", async () => {
    const { deps } = setup(expiresIn(2 * DAY));
    await checkClaudeLoginExpiry(deps);
    const row = (deps.writeAuditEntry as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(row["action"]).toBe("claude_login_expiry_warning");
    expect(String(row["idempotency_key"])).toContain(String(NOW + 2 * DAY));
    expect(JSON.stringify(row)).not.toMatch(/sk-ant|token/i);
  });

  it("sends nothing and records nothing when no expiry is known", async () => {
    for (const state of ["no-file", "unreadable", "no-expiry", "garbage"] as const) {
      const { deps, sent } = setup({ state });
      expect(await checkClaudeLoginExpiry(deps), state).toBe("unknown");
      expect(sent, state).toEqual([]);
      expect(deps.writeAuditEntry, state).not.toHaveBeenCalled();
    }
  });

  it("says so once, in different words, when the login has already expired", async () => {
    const { deps, sent } = setup(expiresIn(-DAY));
    expect(await checkClaudeLoginExpiry(deps)).toBe("expired");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/expired/i);
    expect(sent[0]).toContain("/login claude");
    expect(await checkClaudeLoginExpiry(deps)).toBe("already-warned");
    expect(sent).toHaveLength(1);
  });

  it("a failed send is not recorded, so the next day tries again", async () => {
    const { deps } = setup(expiresIn(2 * DAY));
    const failing: ExpiryDeps = { ...deps, send: vi.fn(async () => { throw new Error("telegram down"); }) };
    expect(await checkClaudeLoginExpiry(failing)).toBe("send-failed");
    expect(deps.writeAuditEntry).not.toHaveBeenCalled();
    expect(await checkClaudeLoginExpiry(deps)).toBe("warned");
  });

  it("runs daily", () => {
    expect(CLAUDE_EXPIRY_CRON).toBe("15 10 * * *");
  });
});
