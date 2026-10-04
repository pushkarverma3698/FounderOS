import { describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock("../../../../src/infra/logger.js", () => {
  const rec = (...a: unknown[]): void => void logged.push(a);
  return { childLogger: () => ({ info: rec, warn: rec, error: rec, debug: rec }) };
});

import {
  createClaudeAdapter,
  lookupOrgId,
  readHostLogin,
  withLoginHint,
  type ClaudeLoginDeps,
  type HostLogin,
  type TokenCheck,
} from "../../../../src/gateway/login/adapters/claude.js";
import type { TokenFileRead } from "../../../../src/infra/claude-token.js";
import { fakePty, osc8 } from "./fake-pty.js";

const TOKEN = `sk-ant-oat01-${"A1b2C3d4".repeat(6)}`;
const CODE = "4/0AX4XfWhSECRETCODE123#statepart";
const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=S1";
const PATHS = { primary: "/h/.claude/pr-brain.token", dispatch: "/h/.claude/claude-code.token" };
const NOW = Date.UTC(2026, 9, 4, 12);
const ORG_NEW = "1c2fa9ef-a5be-445f-b662-15c073270325";
const ORG_HOST = "942d106e-e724-49f9-a8d6-9b0cc4eaec9c";
const HOST: HostLogin = { email: "pushkarai3698@gmail.com", org: ORG_HOST };

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
    lookupOrg: async () => ({ org: ORG_NEW }),
    hostLogin: async () => undefined,
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

describe("login hint", () => {
  it("withLoginHint appends the email the way `claude auth login --email` does and leaves every other parameter alone", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=Ab-_9&state=S1";
    const out = new globalThis.URL(withLoginHint(url, "pushkar@oplify.in"));
    expect(out.searchParams.get("login_hint")).toBe("pushkar@oplify.in");
    expect(withLoginHint(url, "pushkar@oplify.in")).toContain("login_hint=pushkar%40oplify.in");
    for (const k of ["code", "client_id", "redirect_uri", "scope", "code_challenge", "state"]) {
      expect(out.searchParams.get(k)).toBe(new globalThis.URL(url).searchParams.get(k));
    }
    expect(withLoginHint(url, undefined)).toBe(url);
  });

  it("start: puts the hint in the link, names the account, and says to open it in a private tab", async () => {
    const { base } = deps();
    const s = await createClaudeAdapter(base).start("default", "pushkar@oplify.in");
    expect(s.html).toContain("login_hint=pushkar%40oplify.in");
    expect(s.html).toContain("Sign in to Claude as pushkar@oplify.in");
    expect(s.html).toMatch(/private tab/i);
  });

  it("start without a hint still tells him which browser session decides", async () => {
    const s = await createClaudeAdapter(deps().base).start("default");
    expect(s.html).not.toContain("login_hint");
    expect(s.html).toMatch(/private tab/i);
  });
});

describe("lookupOrgId", () => {
  const ok = (headers: Record<string, string>, status = 200) => vi.fn(async () => new Response("{}", { status, headers }));
  it("sends the token only to api.anthropic.com's free count_tokens endpoint and reads the organization header", async () => {
    const f = ok({ "anthropic-organization-id": ORG_NEW });
    expect(await lookupOrgId(TOKEN, f as unknown as typeof fetch)).toEqual({ org: ORG_NEW });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)["anthropic-beta"]).toContain("oauth-2025-04-20");
  });
  it("a response with no header, an HTTP error, or a thrown fetch is a reason, never a guess, and never carries the token", async () => {
    const cases = [ok({}), ok({}, 401), vi.fn(async () => Promise.reject(new Error(`boom ${TOKEN}`)))];
    for (const f of cases) {
      const r = await lookupOrgId(TOKEN, f as unknown as typeof fetch);
      expect("reason" in r).toBe(true);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });
});

describe("readHostLogin", () => {
  const run = (stdout: string, code = 0) => {
    const calls: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
    const spawnFn = ((_cmd: string, args: readonly string[], opts: { env: Record<string, string> }) => {
      calls.push({ args, env: opts.env });
      const child = new (require("node:events").EventEmitter)();
      child.stdout = new (require("node:events").EventEmitter)();
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(stdout));
        child.emit("close", code);
      });
      return child;
    }) as never;
    return { spawnFn, calls };
  };
  const base = { PATH: "/usr/bin", HOME: "/home/founderos", CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: "k", SECRET_BOT_KEY: "x" };

  it("reads the server's own saved login with the token and API keys removed from its environment", async () => {
    const { spawnFn, calls } = run(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: HOST.email, orgId: ORG_HOST }));
    expect(await readHostLogin(spawnFn, base)).toEqual(HOST);
    expect(calls[0]!.args).toEqual(["auth", "status", "--json"]);
    expect(calls[0]!.env["HOME"]).toBe("/home/founderos");
    expect(Object.keys(calls[0]!.env).sort()).toEqual(["HOME", "PATH", "TERM"]);
  });
  it("not logged in, a token login, bad JSON or a non-zero exit all mean: no host login to compare with", async () => {
    for (const out of [
      JSON.stringify({ loggedIn: false }),
      JSON.stringify({ loggedIn: true, authMethod: "oauth_token" }),
      "not json",
    ]) {
      expect(await readHostLogin(run(out).spawnFn, base)).toBeUndefined();
    }
    expect(await readHostLogin(run("{}", 1).spawnFn, base)).toBeUndefined();
  });
});

describe("which account", () => {
  it("finish: says the new token is a DIFFERENT account from the server's saved login, with that login's email", async () => {
    const { base } = deps({ hostLogin: async () => HOST });
    const r = await createClaudeAdapter(base).finish("default", TOKEN, undefined);
    expect(r.ok).toBe(true);
    expect(r.html).toContain("different account");
    expect(r.html).toContain("pushkarai3698@gmail.com");
    expect(r.html).toContain(ORG_NEW.slice(0, 8));
    expect(r.html).not.toContain(ORG_NEW);
    expect(r.html).toContain("plain claude run over SSH");
  });
  it("finish: asks Anthropic and the host login once, not once per wording", async () => {
    const lookupOrg = vi.fn(async () => ({ org: ORG_NEW }));
    const hostLogin = vi.fn(async () => HOST);
    await createClaudeAdapter(deps({ lookupOrg, hostLogin }).base).finish("default", TOKEN, undefined);
    expect(lookupOrg).toHaveBeenCalledTimes(1);
    expect(hostLogin).toHaveBeenCalledTimes(1);
  });
  it("finish: says SAME account when the organizations match", async () => {
    const { base } = deps({ hostLogin: async () => HOST, lookupOrg: async () => ({ org: ORG_HOST }) });
    const r = await createClaudeAdapter(base).finish("default", TOKEN, undefined);
    expect(r.html).toMatch(/same account/i);
  });
  it("finish: with no host login it still shows the org and says there is nothing to compare with", async () => {
    const r = await createClaudeAdapter(deps().base).finish("default", TOKEN, undefined);
    expect(r.html).toContain(ORG_NEW.slice(0, 8));
    expect(r.html).toMatch(/no saved Claude login/);
  });
  it("finish: when the lookup fails the login still succeeds and says it could not tell which account", async () => {
    const { base, written } = deps({ lookupOrg: async () => ({ reason: "HTTP 500" }), hostLogin: async () => HOST });
    const r = await createClaudeAdapter(base).finish("default", TOKEN, undefined);
    expect(r.ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(r.html).toMatch(/could not tell which account/);
  });
  it("finish: a lookup or host read that THROWS cannot fail a verified login", async () => {
    const { base, written } = deps({
      lookupOrg: async () => {
        throw new Error("x");
      },
      hostLogin: async () => {
        throw new Error("y");
      },
    });
    const r = await createClaudeAdapter(base).finish("default", TOKEN, undefined);
    expect(r.ok).toBe(true);
    expect(written).toHaveLength(1);
  });
  it("status: the Claude row names the account relation, and the lookups are cached with the live check", async () => {
    const lookupOrg = vi.fn(async () => ({ org: ORG_NEW }));
    const { base, verify } = deps({ readFile: async () => ({ state: "ok", token: TOKEN, created: "2026-10-04" }), lookupOrg, hostLogin: async () => HOST });
    const a = createClaudeAdapter(base);
    const [r1] = await a.status();
    expect(r1!.ok).toBe(true);
    expect(r1!.detail).toContain("different account");
    expect(r1!.detail).toContain("pushkarai3698@gmail.com");
    expect(r1!.detail).not.toContain("plain claude run");
    await a.status();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(lookupOrg).toHaveBeenCalledTimes(1);
  });
});
