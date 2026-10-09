import { describe, expect, it } from "vitest";
import { CLAUDE_PROBE_CMD, gwsErrorLine, healthLine, OPENROUTER_MIN_USD, parseClaudePing, type HealthReads } from "../../../scripts/lib/health-line.js";

const CLAUDE_OK = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" });
const CLAUDE_LIMITED = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  result: "You've hit your weekly limit · resets Oct 12, 6am (UTC)",
});

const GREEN: HealthReads = {
  openRouter: { balanceUsd: 10.29, keyRemainingUsd: 6.5 },
  aiStudio: { status: 200, body: "{}" },
  claude: { exitCode: 0, stdout: CLAUDE_OK, stderr: "" },
  google: [
    { account: "personal", email: "me@gmail.com", ownLogin: true },
    { account: "work", email: "me@work.com", ownLogin: true },
  ],
  units: { failed: [], gateway: "active" },
  killSwitches: [],
  spend: { yesterdayUsd: 1.234, capUsd: 5 },
};

const reds = (r: HealthReads): string[] => healthLine(r).lines.filter((l) => l.startsWith("🔴"));

describe("parseClaudePing", () => {
  it("passes a normal reply", () => {
    expect(parseClaudePing({ exitCode: 0, stdout: CLAUDE_OK, stderr: "" }).ok).toBe(true);
  });
  it("marks the weekly limit red even though the CLI exits 0, with the reset time", () => {
    const p = parseClaudePing({ exitCode: 0, stdout: CLAUDE_LIMITED, stderr: "" });
    expect(p.ok).toBe(false);
    expect(p.detail).toContain("resets Oct 12, 6am (UTC)");
  });
  it("marks a non-zero exit red with stderr", () => {
    const p = parseClaudePing({ exitCode: 1, stdout: "", stderr: "Not logged in\nmore" });
    expect(p.ok).toBe(false);
    expect(p.detail).toContain("Not logged in");
  });
  it("marks output it cannot read red", () => {
    expect(parseClaudePing({ exitCode: 0, stdout: "garbage", stderr: "" }).ok).toBe(false);
  });
});

describe("healthLine", () => {
  it("is all green on a healthy morning and prints the real numbers", () => {
    const h = healthLine(GREEN);
    expect(h.ok).toBe(true);
    expect(reds(GREEN)).toEqual([]);
    const text = h.lines.join("\n");
    expect(text).toContain("$10.29");
    expect(text).toContain("$6.50");
    expect(text).toContain("$1.23 of $5.00");
    expect(text).toContain("work → me@work.com");
  });
  it("marks an AI Studio 402 red", () => {
    const r = { ...GREEN, aiStudio: { status: 402, body: '{"error":{"message":"credits exhausted"}}' } };
    expect(healthLine(r).ok).toBe(false);
    expect(reds(r).join()).toContain("402");
  });
  it("marks a limited Claude CLI red with the reset time", () => {
    const r = { ...GREEN, claude: { exitCode: 0, stdout: CLAUDE_LIMITED, stderr: "" } };
    expect(healthLine(r).ok).toBe(false);
    expect(reds(r).join()).toContain("resets Oct 12");
  });
  it("marks the OpenRouter key limit red even when the balance is fine", () => {
    const r = { ...GREEN, openRouter: { balanceUsd: 10.29, keyRemainingUsd: OPENROUTER_MIN_USD - 0.6 } };
    expect(healthLine(r).ok).toBe(false);
    expect(reds(r).join()).toContain("$0.40");
  });
  it("marks a low OpenRouter balance red", () => {
    expect(healthLine({ ...GREEN, openRouter: { balanceUsd: 0.2, keyRemainingUsd: null } }).ok).toBe(false);
  });
  it("marks a Google login failure red and names the account", () => {
    const r = { ...GREEN, google: [{ account: "work", error: "invalid_grant", ownLogin: true }] };
    expect(healthLine(r).ok).toBe(false);
    expect(reds(r).join()).toContain("work: invalid_grant");
  });
  it("marks two accounts reading the same mailbox red (the #1031 mix-up)", () => {
    const r = {
      ...GREEN,
      google: [
        { account: "personal", email: "me@gmail.com", ownLogin: true },
        { account: "work", email: "me@gmail.com", ownLogin: true },
      ],
    };
    expect(reds(r).join()).toContain("personal and work both read me@gmail.com");
  });
  it("marks failed units and a stopped gateway red", () => {
    const r = { ...GREEN, units: { failed: ["job-run@1.service", "x.timer"], gateway: "inactive" } };
    const text = reds(r).join("\n");
    expect(text).toContain("2 failed units: job-run@1.service, x.timer");
    expect(text).toContain("inactive");
  });
  it("marks spend over the cap red", () => {
    const r = { ...GREEN, spend: { yesterdayUsd: 6.1, capUsd: 5 } };
    expect(reds(r).join()).toContain("$6.10 of $5.00");
  });
  it("marks a read that failed red with its reason, never green", () => {
    const r = { ...GREEN, openRouter: { error: "HTTP 401" }, spend: { error: "db down" } };
    const text = reds(r).join("\n");
    expect(text).toContain("HTTP 401");
    expect(text).toContain("db down");
  });
  it("shows a kill switch without making the line red", () => {
    const r = { ...GREEN, killSwitches: ["pr-brain.off"] };
    const h = healthLine(r);
    expect(h.ok).toBe(true);
    expect(h.lines.join("\n")).toContain("pr-brain.off");
  });
});

describe("gwsErrorLine", () => {
  it("skips the keyring banner and prints the line that carries the error", () => {
    const raw = "Using keyring backend: keyring\nerror[auth]: Authentication failed: Failed to get token: Server error: invalid_grant: Bad Request";
    expect(gwsErrorLine(raw)).toContain("invalid_grant");
    expect(gwsErrorLine(raw)).not.toContain("keyring");
  });
  it("falls back to the first non-banner line, then the banner itself", () => {
    expect(gwsErrorLine("Using keyring backend: keyring\nETIMEDOUT")).toBe("ETIMEDOUT");
    expect(gwsErrorLine("Using keyring backend: keyring")).toBe("Using keyring backend: keyring");
  });
});

describe("CLAUDE_PROBE_CMD", () => {
  it("reads stdin from /dev/null so claude -p does not warn about missing stdin data", () => {
    expect(CLAUDE_PROBE_CMD).toMatch(/claude -p ok .*< \/dev\/null/);
  });
});
