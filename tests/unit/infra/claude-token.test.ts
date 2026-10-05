import { mkdir, mkdtemp, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeTokenPaths, parseExpiry, readClaudeToken, readHostRefreshExpiry, hostLoginNeedsRenewal, readTokenFile, writeClaudeTokenFiles, WARN_AHEAD_MS } from "../../../src/infra/claude-token.js";

async function paths() {
  const dir = await mkdtemp(join(tmpdir(), "claude-token-test-"));
  return { primary: join(dir, "sub", "pr-brain.token"), dispatch: join(dir, "sub", "claude-code.token") };
}

describe("claude token files", () => {
  it("writes the formats the daemons read, both mode 0600, atomically", async () => {
    const p = await paths();
    await writeClaudeTokenFiles("sk-ant-oat01-T", "2026-10-04", p);
    expect(await readFile(p.primary, "utf8")).toBe("sk-ant-oat01-T\n2026-10-04\n");
    expect(await readFile(p.dispatch, "utf8")).toBe("sk-ant-oat01-T\n");
    expect((await stat(p.primary)).mode & 0o777).toBe(0o600);
    expect((await stat(p.dispatch)).mode & 0o777).toBe(0o600);
  });

  it("re-writing an existing 0644 file ends at 0600", async () => {
    const p = await paths();
    await writeClaudeTokenFiles("a", "2026-10-01", p);
    await chmod(p.primary, 0o644);
    await writeClaudeTokenFiles("b", "2026-10-04", p);
    expect((await stat(p.primary)).mode & 0o777).toBe(0o600);
    expect(await readTokenFile(p.primary)).toEqual({ state: "ok", token: "b", created: "2026-10-04" });
  });

  it("reads like pr-brain: mode must be exactly 600; missing and empty are distinct", async () => {
    const p = await paths();
    expect(await readTokenFile(p.primary)).toEqual({ state: "missing" });
    await writeClaudeTokenFiles("t", "2026-10-04", p);
    await chmod(p.primary, 0o644);
    expect(await readTokenFile(p.primary)).toEqual({ state: "bad-mode", mode: "644" });
    await writeFile(p.primary, "\n", { mode: 0o600 });
    await chmod(p.primary, 0o600);
    expect(await readTokenFile(p.primary)).toEqual({ state: "empty" });
  });

  it("a token with no date line has created null", async () => {
    const p = await paths();
    await writeClaudeTokenFiles("t", "2026-10-04", p);
    expect(await readTokenFile(p.dispatch)).toEqual({ state: "ok", token: "t", created: null });
  });

  it("readClaudeToken prefers pr-brain's file, falls back to the dispatch file, else undefined", async () => {
    const p = await paths();
    expect(await readClaudeToken(p)).toBeUndefined();
    await writeClaudeTokenFiles("one", "2026-10-04", p);
    expect(await readClaudeToken(p)).toBe("one");
    await chmod(p.primary, 0o644);
    expect(await readClaudeToken(p)).toBe("one"); // dispatch copy
    await chmod(p.dispatch, 0o644);
    expect(await readClaudeToken(p)).toBeUndefined();
  });

  it("paths honour the same overrides the daemons honour", () => {
    expect(claudeTokenPaths({}, "/h")).toEqual({ primary: "/h/.claude/pr-brain.token", dispatch: "/h/.claude/claude-code.token" });
    expect(claudeTokenPaths({ PR_BRAIN_TOKEN_FILE: "/a", AGENT_DISPATCH_CLAUDE_TOKEN_FILE: "/b" }, "/h")).toEqual({ primary: "/a", dispatch: "/b" });
  });
});

describe("host login refresh-token expiry", () => {
  const MS = Date.parse("2026-11-01T00:00:00Z");

  it.each([
    ["epoch ms number", MS, MS],
    ["epoch ms as a digit string", String(MS), MS],
    ["epoch seconds number", MS / 1000, MS],
    ["ISO string", "2026-11-01T00:00:00Z", MS],
  ])("parseExpiry reads %s", (_name, raw, expected) => {
    expect(parseExpiry(raw)).toBe(expected);
  });

  it.each([[undefined], [null], [""], ["soon"], [{}], [true], [0], [-5], [Number.NaN]])("parseExpiry rejects %j", (raw) => {
    expect(parseExpiry(raw)).toBeUndefined();
  });

  async function home(creds: string | undefined) {
    const dir = await mkdtemp(join(tmpdir(), "claude-host-test-"));
    if (creds !== undefined) {
      await mkdir(join(dir, ".claude"), { recursive: true });
      await writeFile(join(dir, ".claude", ".credentials.json"), creds, { mode: 0o600 });
    }
    return dir;
  }

  it("returns only the expiry, never the tokens beside it", async () => {
    const h = await home(JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-SECRET-A", refreshToken: "sk-ant-SECRET-R", refreshTokenExpiresAt: MS }, mcpOAuth: { x: 1 } }));
    const got = await readHostRefreshExpiry(h);
    expect(got).toEqual({ state: "ok", expiresAtMs: MS });
    expect(JSON.stringify(got)).not.toContain("SECRET");
  });

  it("names why there is no expiry, without echoing file content", async () => {
    expect(await readHostRefreshExpiry(await home(undefined))).toEqual({ state: "no-file" });
    expect(await readHostRefreshExpiry(await home("{not json sk-ant-SECRET"))).toEqual({ state: "unreadable" });
    expect(await readHostRefreshExpiry(await home(JSON.stringify({ claudeAiOauth: { accessToken: "x" } })))).toEqual({ state: "no-expiry" });
    expect(await readHostRefreshExpiry(await home(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: "sk-ant-SECRET" } })))).toEqual({ state: "garbage" });
  });
});

describe("hostLoginNeedsRenewal", () => {
  const NOW = 1_800_000_000_000;
  it("is true inside the window and after the expiry, false outside it", () => {
    expect(hostLoginNeedsRenewal({ state: "ok", expiresAtMs: NOW + WARN_AHEAD_MS }, NOW)).toBe(true);
    expect(hostLoginNeedsRenewal({ state: "ok", expiresAtMs: NOW - 1 }, NOW)).toBe(true);
    expect(hostLoginNeedsRenewal({ state: "ok", expiresAtMs: NOW + WARN_AHEAD_MS + 1 }, NOW)).toBe(false);
  });
  it("claims nothing when the expiry could not be read", () => {
    for (const state of ["no-file", "unreadable", "no-expiry", "garbage"] as const) expect(hostLoginNeedsRenewal({ state }, NOW)).toBe(false);
  });
});
