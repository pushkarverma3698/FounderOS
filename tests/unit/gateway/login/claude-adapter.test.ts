import { describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock("../../../../src/infra/logger.js", () => {
  const rec = (...a: unknown[]): void => void logged.push(a);
  return { childLogger: () => ({ info: rec, warn: rec, error: rec, debug: rec }) };
});

import { createClaudeAdapter, type ClaudeLoginDeps, type TokenCheck } from "../../../../src/gateway/login/adapters/claude.js";
import type { TokenFileRead } from "../../../../src/infra/claude-token.js";
import { fakePty, osc8 } from "./fake-pty.js";

const TOKEN = `sk-ant-oat01-${"A1b2C3d4".repeat(6)}`;
const CODE = "4/0AX4XfWhSECRETCODE123#statepart";
const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=S1";
const PATHS = { primary: "/h/.claude/pr-brain.token", dispatch: "/h/.claude/claude-code.token" };
const NOW = Date.UTC(2026, 9, 4, 12);

function deps(over: Partial<ClaudeLoginDeps> = {}) {
  const written: Array<{ token: string; today: string }> = [];
  const home = { dir: "/scratch/h", cleanup: vi.fn(async () => undefined) };
  const verify = vi.fn(async (): Promise<TokenCheck> => ({ kind: "ok" }));
  const base: ClaudeLoginDeps = {
    spawnPty: () => fakePty(osc8(URL)).child,
    verify,
    paths: PATHS,
    readFile: async (): Promise<TokenFileRead> => ({ state: "missing" }),
    writeTokens: async (token, today) => void written.push({ token, today }),
    makeHome: async () => home,
    now: () => NOW,
    sleep: async () => undefined,
    env: { PATH: "/usr/bin", SECRET_BOT_KEY: "must-not-reach-the-child" },
    ...over,
  };
  return { base, written, home, verify };
}

/** A child that prints the token only after the code and Enter are typed. */
const tokenAfterPaste = () =>
  fakePty(osc8(URL), (t, feed) => {
    if (t === "\r") feed(`\nYour OAuth token (valid for 1 year):\n\n${TOKEN}\n\nStore this token securely.\n`);
  });

describe("claude login adapter", () => {
  it("start: sends the sign-in link, spawns setup-token in a scratch HOME with a minimal env, and dispose kills it", async () => {
    const pty = fakePty(osc8(URL));
    const calls: Array<[string[], Record<string, string>]> = [];
    const { base, home } = deps({
      spawnPty: (argv, env) => {
        calls.push([[...argv], env]);
        return pty.child;
      },
    });
    const a = createClaudeAdapter(base);
    const s = await a.start("default");
    expect(s.html).toContain('href="https://claude.com/cai/oauth/authorize?code=true&amp;client_id=abc&amp;state=S1"');
    const [argv, env] = calls[0]!;
    expect(argv).toEqual(["claude", "setup-token"]);
    expect(env["HOME"]).toBe("/scratch/h");
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "TERM"]);
    await s.dispose?.();
    expect(pty.kill).toHaveBeenCalled();
    expect(home.cleanup).toHaveBeenCalled();
  });

  it("start: no link means the child is killed and the error names the cause", async () => {
    const pty = fakePty("loading...");
    const { base, home } = deps({ spawnPty: () => pty.child });
    await expect(createClaudeAdapter(base).start("default")).rejects.toThrow(/did not print a sign-in link/);
    expect(pty.kill).toHaveBeenCalled();
    expect(home.cleanup).toHaveBeenCalled();
  });

  it("finish: pastes the code, verifies the printed token with a real call, then writes both files; the token never reaches html or logs", async () => {
    logged.length = 0;
    const pty = tokenAfterPaste();
    const { base, written, verify } = deps({ spawnPty: () => pty.child });
    const a = createClaudeAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", `  ${CODE}  `, s.state);
    expect(pty.writes).toEqual([CODE, "\r"]);
    expect(verify).toHaveBeenCalledWith(TOKEN);
    expect(written).toEqual([{ token: TOKEN, today: "2026-10-04" }]);
    expect(r.ok).toBe(true);
    expect(pty.kill).toHaveBeenCalled();
    for (const text of [s.html, r.html, JSON.stringify(logged)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("A1b2C3d4A1b2C3d4");
      expect(text).not.toContain("SECRETCODE");
    }
  });

  it("finish: writes nothing when the verification call rejects the token", async () => {
    const { base, written } = deps({ spawnPty: () => tokenAfterPaste().child, verify: async () => ({ kind: "rejected" }) });
    const a = createClaudeAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", CODE, s.state);
    expect(r.ok).toBe(false);
    expect(r.html).toMatch(/rejected/);
    expect(written).toEqual([]);
  });

  it("finish: writes nothing when the check cannot run (unknown is not a pass)", async () => {
    const { base, written } = deps({ spawnPty: () => tokenAfterPaste().child, verify: async () => ({ kind: "unknown", reason: "the check timed out" }) });
    const a = createClaudeAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", CODE, s.state);
    expect(r.ok).toBe(false);
    expect(r.html).toContain("nothing was saved");
    expect(written).toEqual([]);
  });

  it("finish: reports a refused code (the CLI's real 400 text) and saves nothing", async () => {
    const pty = fakePty(osc8(URL), (t, feed) => {
      if (t === "\r") feed("\nOAuth error: Request failed with status code 400\nPress Enter to retry.\n");
    });
    const { base, written, verify } = deps({ spawnPty: () => pty.child });
    const a = createClaudeAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", CODE, s.state);
    expect(r.ok).toBe(false);
    expect(r.html).toMatch(/refused that code/);
    expect(verify).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("finish: refuses text that is not a code without touching the child", async () => {
    const pty = tokenAfterPaste();
    const { base } = deps({ spawnPty: () => pty.child });
    const a = createClaudeAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", "this is not a code", s.state);
    expect(r.ok).toBe(false);
    expect(pty.writes).toEqual([]);
  });

  it("finish: a pasted token (laptop fallback) skips the child and goes straight to verification", async () => {
    const { base, written, verify } = deps();
    const a = createClaudeAdapter(base);
    const r = await a.finish("default", TOKEN, undefined);
    expect(verify).toHaveBeenCalledWith(TOKEN);
    expect(written).toEqual([{ token: TOKEN, today: "2026-10-04" }]);
    expect(r.ok).toBe(true);
    expect(r.html).not.toContain(TOKEN);
  });

  it("finish: an ended attempt says so", async () => {
    const pty = tokenAfterPaste();
    const { base } = deps({ spawnPty: () => pty.child });
    const a = createClaudeAdapter(base);
    const s = await a.start("default");
    pty.kill();
    const r = await a.finish("default", CODE, s.state);
    expect(r.ok).toBe(false);
    expect(r.html).toMatch(/has ended/);
  });

  it("a write failure is reported without the token", async () => {
    const { base } = deps({
      writeTokens: async () => {
        throw Object.assign(new Error(`EACCES ${TOKEN}`), { code: "EACCES" });
      },
    });
    const r = await createClaudeAdapter(base).finish("default", TOKEN, undefined);
    expect(r.ok).toBe(false);
    expect(r.html).toContain("EACCES");
    expect(r.html).not.toContain(TOKEN);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });

  describe("status", () => {
    const fileOk: TokenFileRead = { state: "ok", token: TOKEN, created: "2026-09-20" };
    it("never set", async () => {
      const [r] = await createClaudeAdapter(deps().base).status();
      expect(r).toMatchObject({ ok: false, detail: "never set" });
    });
    it("reports the date and works; caches the live check for 10 minutes, then re-runs it", async () => {
      let now = NOW;
      const { base, verify } = deps({ readFile: async () => fileOk, now: () => now });
      const a = createClaudeAdapter(base);
      const [r1] = await a.status();
      expect(r1!.ok).toBe(true);
      expect(r1!.detail).toContain("token from 2026-09-20, works");
      await a.status();
      expect(verify).toHaveBeenCalledTimes(1);
      now += 9 * 60_000;
      await a.status();
      expect(verify).toHaveBeenCalledTimes(1);
      now += 2 * 60_000;
      await a.status();
      expect(verify).toHaveBeenCalledTimes(2);
    });
    it("rejected", async () => {
      const { base } = deps({ readFile: async () => fileOk, verify: async () => ({ kind: "rejected" }) });
      const [r] = await createClaudeAdapter(base).status();
      expect(r).toMatchObject({ ok: false });
      expect(r!.detail).toContain("rejected");
      expect(r!.detail).not.toContain(TOKEN);
    });
    it("a file with the wrong mode is ignored, as the daemons ignore it", async () => {
      const { base, verify } = deps({ readFile: async () => ({ state: "bad-mode", mode: "644" }) });
      const [r] = await createClaudeAdapter(base).status();
      expect(r!.detail).toContain("mode 644");
      expect(verify).not.toHaveBeenCalled();
    });
    it("never throws", async () => {
      const { base } = deps({
        readFile: async () => {
          throw new Error("boom");
        },
      });
      const [r] = await createClaudeAdapter(base).status();
      expect(r!.ok).toBe(false);
    });
  });
});
