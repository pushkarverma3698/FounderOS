import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/infra/logger.js", () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createAgyAdapter, type AgyLoginDeps, type RunResult } from "../../../../src/gateway/login/adapters/agy.js";
import { createClaudeAdapter, type ClaudeLoginDeps, type TokenCheck } from "../../../../src/gateway/login/adapters/claude.js";
import { probeStoredClaude, signOutClaude } from "../../../../src/gateway/login/adapters/claude-check.js";
import { createGoogleAdapter, type GoogleLoginDeps } from "../../../../src/gateway/login/adapters/google.js";
import { parseClientSecret } from "../../../../src/gateway/login/google-oauth.js";

const SECRET_TOKEN = `sk-ant-oat01-${"Zz9y8X7w".repeat(6)}`;

// ── agy ──────────────────────────────────────────────────────────────────────

function agy(models: RunResult, rm: RunResult = { code: 0, out: "" }) {
  const scripts: string[] = [];
  const run = vi.fn(async (argv: readonly string[]): Promise<RunResult> => {
    const script = argv[argv.indexOf("-c") + 1] ?? "";
    scripts.push(script);
    return script.includes("agy models") ? models : rm;
  });
  const over: Partial<AgyLoginDeps> = { run, user: undefined, readDownFlag: async () => null, now: () => 1, env: { PATH: "/usr/bin" } };
  return { a: createAgyAdapter(over), scripts };
}

describe("agy logout", () => {
  it("deletes the token, its .bak and .new, and is ok only because `agy models` now says to sign in", async () => {
    const { a, scripts } = agy({ code: 1, out: "Please sign in to continue" });
    const r = await a.logout!("default");
    expect(r.ok).toBe(true);
    expect(r.html).toContain("signed out");
    const rm = scripts.find((s) => s.startsWith("rm -f"))!;
    expect(rm).toContain('"$HOME/.gemini/antigravity-cli/antigravity-oauth-token"');
    expect(rm).toContain(".bak");
    expect(rm).toContain(".new");
    expect(scripts.findIndex((s) => s.startsWith("rm -f"))).toBeLessThan(scripts.findIndex((s) => s.includes("agy models")));
  });

  it("is NOT ok when the call still works afterwards: another credential is active", async () => {
    const { a } = agy({ code: 0, out: "gemini-3-pro" });
    const r = await a.logout!("default");
    expect(r.ok).toBe(false);
    expect(r.html).toContain("another credential source is active");
  });

  it("is NOT ok when the file could not be deleted", async () => {
    const { a } = agy({ code: 1, out: "Please sign in" }, { code: 1, out: "rm: cannot remove" });
    const r = await a.logout!("default");
    expect(r.ok).toBe(false);
    expect(r.html).toContain("still in place");
  });

  it("says plainly that the proof did not run when the check is unavailable", async () => {
    const { a } = agy({ code: null, out: "" });
    const r = await a.logout!("default");
    expect(r.ok).toBe(true);
    expect(r.html).toContain("not verified");
  });
});

// ── claude ───────────────────────────────────────────────────────────────────

function claude(over: Partial<ClaudeLoginDeps> = {}) {
  const signOut = vi.fn(async () => ({ hostLogout: "ok" as const }));
  const probeStored = vi.fn(async (): Promise<TokenCheck> => ({ kind: "rejected" }));
  const adapter = createClaudeAdapter({
    paths: { primary: "/h/.claude/pr-brain.token", dispatch: "/h/.claude/claude-code.token" },
    readFile: async () => ({ state: "missing" }),
    signOut,
    probeStored,
    env: { PATH: "/usr/bin" },
    ...over,
  });
  return { adapter, signOut, probeStored };
}

describe("claude logout", () => {
  it("ok when both token files are gone and the stored-credentials call is refused; says what stays valid at Anthropic", async () => {
    const { adapter, signOut } = claude();
    const r = await adapter.logout!("default");
    expect(signOut).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
    expect(r.html).toContain("refused, as expected");
    expect(r.html).toContain("until you revoke it in claude.ai");
  });

  it("NOT ok when a token file is still on disk", async () => {
    const { adapter } = claude({ readFile: async (p) => (p.endsWith("pr-brain.token") ? { state: "ok", token: SECRET_TOKEN, created: undefined } : { state: "missing" }) as never });
    const r = await adapter.logout!("default");
    expect(r.ok).toBe(false);
    expect(r.html).not.toContain(SECRET_TOKEN);
  });

  it("NOT ok when the call with only stored credentials still works", async () => {
    const { adapter } = claude({ probeStored: async () => ({ kind: "ok" }), signOut: async () => ({ hostLogout: "failed" }) });
    const r = await adapter.logout!("default");
    expect(r.ok).toBe(false);
    expect(r.html).toContain("still works");
    expect(r.html).toContain("claude auth logout");
  });

  it("an unknown probe is ok but says that part is not verified", async () => {
    const { adapter } = claude({ probeStored: async () => ({ kind: "unknown", reason: "the claude binary could not be started" }) });
    const r = await adapter.logout!("default");
    expect(r.ok).toBe(true);
    expect(r.html).toContain("not verified");
  });

  it("a failed delete is reported, never as signed out", async () => {
    const { adapter, probeStored } = claude({ signOut: async () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } });
    const r = await adapter.logout!("default");
    expect(r.ok).toBe(false);
    expect(r.html).toContain("EACCES");
    expect(probeStored).not.toHaveBeenCalled();
  });
});

function fakeSpawn(stdout: string, code: number) {
  const calls: Array<{ cmd: string; args: readonly string[]; env: Record<string, string>; cwd: string }> = [];
  const spawnFn = ((cmd: string, args: readonly string[], opts: { env: Record<string, string>; cwd: string }) => {
    calls.push({ cmd, args, env: opts.env, cwd: opts.cwd });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", code);
    });
    return child;
  }) as never;
  return { spawnFn, calls };
}

describe("claude-check: signOutClaude and probeStoredClaude", () => {
  it("removes both token files and both server login copies, runs `claude auth logout`, and leaves other files alone", async () => {
    const home = mkdtempSync(join(tmpdir(), "signout-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const paths = { primary: join(home, ".claude", "pr-brain.token"), dispatch: join(home, ".claude", "claude-code.token") };
      const gone = [paths.primary, paths.dispatch, join(home, ".claude", ".credentials.json.before-login"), join(home, ".claude.json.before-login")];
      const kept = join(home, ".claude", "settings.json");
      for (const f of [...gone, kept]) writeFileSync(f, "x");
      const f = fakeSpawn("", 0);
      const out = await signOutClaude(paths, f.spawnFn, { PATH: "/usr/bin", HOME: home, ANTHROPIC_API_KEY: "must-not-reach-claude" });
      expect(out.hostLogout).toBe("ok");
      for (const g of gone) expect(existsSync(g)).toBe(false);
      expect(existsSync(kept)).toBe(true);
      expect(f.calls[0]).toMatchObject({ cmd: "claude", args: ["auth", "logout"] });
      expect(Object.keys(f.calls[0]!.env).sort()).toEqual(["HOME", "PATH", "TERM"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a failing `claude auth logout` without throwing", async () => {
    const home = mkdtempSync(join(tmpdir(), "signout-"));
    try {
      const f = fakeSpawn("", 1);
      expect((await signOutClaude({ primary: join(home, "a"), dispatch: join(home, "b") }, f.spawnFn, { PATH: "/usr/bin", HOME: home })).hostLogout).toBe("failed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the stored-credentials probe uses the bot's HOME and no token or key variable, and classifies the captured 401", async () => {
    const f = fakeSpawn(JSON.stringify({ is_error: true, api_error_status: 401, result: "Failed to authenticate." }), 1);
    const r = await probeStoredClaude(f.spawnFn, { PATH: "/usr/bin", HOME: "/home/founderos", CLAUDE_CODE_OAUTH_TOKEN: SECRET_TOKEN, ANTHROPIC_API_KEY: "k" });
    expect(r).toEqual({ kind: "rejected" });
    expect(f.calls[0]!.env).toEqual({ PATH: "/usr/bin", HOME: "/home/founderos", TERM: "xterm-256color" });
  });
});

// ── google ───────────────────────────────────────────────────────────────────

const client = parseClientSecret(JSON.stringify({ installed: { client_id: "cid", client_secret: "csec", redirect_uris: ["http://localhost"] } }));

function google(over: Partial<GoogleLoginDeps> = {}) {
  const files = new Set<string>(["/acc/personal/gws/credentials.json", "/acc/personal/gws/credentials.json.bak"]);
  const d: GoogleLoginDeps = {
    readClient: async () => client,
    mailboxes: () => ["turicks", "personal", "naggar", "wife"],
    profileDir: (a) => `/acc/${a}/gws`,
    runGws: async (_args, dir) => (files.has(`${dir}/credentials.json`) ? { ok: true, stdout: "", parsed: { emailAddress: "me@example.com" } } : { ok: false, error: "no credentials" }),
    doFetch: fetch,
    fileExists: (p) => files.has(p),
    writeCredentials: async () => undefined,
    backup: async () => false,
    restore: async () => undefined,
    clearAlerts: vi.fn(),
    forget: vi.fn(async () => undefined),
    deleteCredentials: vi.fn(async (p: string) => void (files.delete(p), files.delete(`${p}.bak`))),
    ...over,
  };
  return { a: createGoogleAdapter(d), d, files };
}

describe("google logout", () => {
  it("deletes a built-in account's login and backup, and is ok only because the same Gmail call now fails", async () => {
    const { a, d, files } = google();
    const r = await a.logout!("personal");
    expect(d.deleteCredentials).toHaveBeenCalledWith("/acc/personal/gws/credentials.json");
    expect(files.size).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.html).toContain("a Gmail call now fails");
    expect(r.html).toContain("/login google personal");
  });

  it("is NOT ok when Gmail still answers for that account", async () => {
    const { a } = google({ runGws: async () => ({ ok: true, stdout: "", parsed: { emailAddress: "other@example.com" } }) });
    const r = await a.logout!("personal");
    expect(r.ok).toBe(false);
    expect(r.html).toContain("other@example.com");
    expect(r.html).toContain("not signed out");
  });

  it("an added mailbox is removed entirely (folder and name), like remove", async () => {
    const { a, d } = google();
    const r = await a.logout!("wife");
    expect(d.forget).toHaveBeenCalledWith("wife");
    expect(d.deleteCredentials).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });
});
