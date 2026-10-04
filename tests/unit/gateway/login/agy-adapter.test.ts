import { describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock("../../../../src/infra/logger.js", () => {
  const rec = (...a: unknown[]): void => void logged.push(a);
  return { childLogger: () => ({ info: rec, warn: rec, error: rec, debug: rec }) };
});

import { classifyAgyModels, createAgyAdapter, type AgyLoginDeps, type RunResult } from "../../../../src/gateway/login/adapters/agy.js";
import { fakePty, osc8 } from "./fake-pty.js";

const URL = "https://accounts.google.com/o/oauth2/auth?client_id=1&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=S";
const CODE = "4/0AX4XfWgSECRETAGYCODE";
const NOW = Date.UTC(2026, 9, 4);

/** A fake machine: `run` answers the shell snippets the adapter sends, and records every argv. */
function machine(over: { mktemp?: RunResult; models?: (home: string | null) => RunResult; landed?: boolean; installCode?: number } = {}) {
  const argvs: string[][] = [];
  const scripts: string[] = [];
  const run = vi.fn(async (argv: readonly string[]): Promise<RunResult> => {
    argvs.push([...argv]);
    const script = argv[argv.indexOf("-c") + 1] ?? "";
    scripts.push(script);
    if (script.startsWith("mktemp")) return over.mktemp ?? { code: 0, out: "/tmp/tmp.AbC123\n" };
    if (script.startsWith("test -s")) return { code: over.landed === false ? 1 : 0, out: "" };
    if (script.includes("agy models")) {
      const home = /HOME='([^']+)'/.exec(script)?.[1] ?? null;
      return over.models ? over.models(home) : { code: 0, out: "gemini-3-pro\nclaude-sonnet-5-5\n" };
    }
    if (script.startsWith("set -e")) return { code: over.installCode ?? 0, out: "" };
    return { code: 0, out: "" };
  });
  return { run, argvs, scripts };
}

function deps(m: ReturnType<typeof machine>, over: Partial<AgyLoginDeps> = {}) {
  const pty = fakePty(osc8(URL));
  const spawned: Array<{ argv: string[]; env: Record<string, string> }> = [];
  const base: Partial<AgyLoginDeps> = {
    spawnPty: (argv, env) => {
      spawned.push({ argv: [...argv], env });
      return pty.child;
    },
    run: m.run,
    readDownFlag: async () => null,
    now: () => NOW,
    sleep: async () => undefined,
    env: { PATH: "/usr/bin" },
    user: undefined,
    ...over,
  };
  return { base, pty, spawned };
}

describe("classifyAgyModels", () => {
  it("sign-in text is rejected whatever the exit code", () => {
    expect(classifyAgyModels({ code: 1, out: "Please sign in to continue" }, false).kind).toBe("rejected");
    expect(classifyAgyModels({ code: 0, out: "Please sign in" }, false).kind).toBe("rejected");
  });
  it("exit 0 is ok; no binary and sudo refusals are unavailable, not rejected", () => {
    expect(classifyAgyModels({ code: 0, out: "models" }, false).kind).toBe("ok");
    expect(classifyAgyModels({ code: null, out: "" }, false).kind).toBe("unavailable");
    const nnp = classifyAgyModels({ code: 1, out: "sudo: The \"no new privileges\" flag is set" }, true);
    expect(nnp).toMatchObject({ kind: "unavailable" });
  });
});

describe("agy login adapter: start", () => {
  it("builds the login in a scratch HOME, sends the Google link, and dispose kills the child and removes the scratch dir", async () => {
    const m = machine();
    const { base, pty, spawned } = deps(m);
    const a = createAgyAdapter(base);
    const s = await a.start("default");
    expect(s.html).toContain('href="https://accounts.google.com/o/oauth2/auth?client_id=1&amp;redirect_uri=');
    expect(spawned[0]!.argv).toEqual(["env", "HOME=/tmp/tmp.AbC123", "TERM=xterm-256color", "agy"]);
    expect(Object.keys(spawned[0]!.env).sort()).toEqual(["HOME", "PATH", "TERM"]);
    await s.dispose?.();
    expect(pty.kill).toHaveBeenCalled();
    expect(m.scripts.some((x) => x.startsWith("rm -rf -- '/tmp/tmp.AbC123'"))).toBe(true);
  });

  it("presses Enter on the Google OAuth menu entry, then takes the link", async () => {
    const pty = fakePty("  1. Google OAuth\n  2. API key\n", (t, feed) => {
      if (t === "\r") feed(osc8(URL));
    });
    const m = machine();
    const { base } = deps(m, { spawnPty: () => pty.child });
    const s = await createAgyAdapter(base).start("default");
    expect(pty.writes).toEqual(["\r"]);
    expect(s.html).toContain("accounts.google.com");
  });

  it("a bot that cannot reach agy (sudo refused under NoNewPrivileges) gets the ssh command, spawns nothing", async () => {
    const m = machine({ mktemp: { code: 1, out: 'sudo: The "no new privileges" flag is set' } });
    const { base, spawned } = deps(m, { user: "antigravity" });
    await expect(createAgyAdapter(base).start("default")).rejects.toThrow(/NoNewPrivileges.*ssh -t founderos-vps 'sudo -u antigravity -i agy'/);
    expect(spawned).toEqual([]);
    expect(m.argvs[0]!.slice(0, 5)).toEqual(["sudo", "-n", "-i", "-u", "antigravity"]);
  });

  it("no link: kills the child, cleans up, and says what it saw", async () => {
    const pty = fakePty("starting...");
    const m = machine();
    const { base } = deps(m, { spawnPty: () => pty.child });
    await expect(createAgyAdapter(base).start("default")).rejects.toThrow(/no menu appeared/);
    expect(pty.kill).toHaveBeenCalled();
  });

  it("a mktemp path with shell metacharacters is refused", async () => {
    const m = machine({ mktemp: { code: 0, out: "/tmp/x'; rm -rf /; '\n" } });
    const { base, spawned } = deps(m);
    await expect(createAgyAdapter(base).start("default")).rejects.toThrow();
    expect(spawned).toEqual([]);
  });
});

describe("agy login adapter: finish", () => {
  it("pastes the code, proves the new login in the scratch HOME, then installs it; the code never reaches html, logs or argv", async () => {
    logged.length = 0;
    const m = machine();
    const { base, pty } = deps(m);
    const a = createAgyAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", ` ${CODE} `, s.state);
    expect(pty.writes).toEqual([CODE, "\r"]);
    expect(r.ok).toBe(true);
    const order = m.scripts.map((x) => (x.startsWith("test -s") ? "landed" : x.includes("HOME='/tmp/tmp.AbC123' agy models") ? "proof" : x.startsWith("set -e") ? "install" : x.includes("agy models") ? "live" : "other"));
    expect(order.indexOf("landed")).toBeLessThan(order.indexOf("proof"));
    expect(order.indexOf("proof")).toBeLessThan(order.indexOf("install"));
    expect(order.indexOf("install")).toBeLessThan(order.indexOf("live"));
    const install = m.scripts.find((x) => x.startsWith("set -e"))!;
    expect(install).toContain(".bak"); // the old login is kept
    expect(install).toContain("chmod 600");
    for (const text of [s.html, r.html, JSON.stringify(logged), JSON.stringify(m.argvs)]) {
      expect(text).not.toContain("SECRETAGYCODE");
    }
  });

  it("never replaces the working login when the new one fails agy models in the scratch HOME", async () => {
    const m = machine({ models: (home) => (home ? { code: 1, out: "Please sign in" } : { code: 0, out: "ok" }) });
    const { base } = deps(m);
    const a = createAgyAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", CODE, s.state);
    expect(r.ok).toBe(false);
    expect(r.html).toContain("untouched");
    expect(m.scripts.some((x) => x.startsWith("set -e"))).toBe(false);
  });

  it("never replaces the working login when no login file appears after the code", async () => {
    const m = machine({ landed: false });
    const { base } = deps(m);
    const a = createAgyAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", CODE, s.state);
    expect(r.ok).toBe(false);
    expect(m.scripts.some((x) => x.startsWith("set -e"))).toBe(false);
  });

  it("restores the old login when the installed one is rejected live", async () => {
    let installed = false;
    const m = machine();
    const inner = m.run.getMockImplementation()!;
    m.run.mockImplementation(async (argv) => {
      const script = argv[argv.indexOf("-c") + 1] ?? "";
      if (script.startsWith("set -e")) installed = true;
      if (installed && script.includes("agy models") && !script.includes("HOME='")) return { code: 1, out: "Please sign in" };
      return inner(argv);
    });
    const { base } = deps(m);
    const a = createAgyAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", CODE, s.state);
    expect(r.ok).toBe(false);
    expect(r.html).toContain("restored");
    expect(m.scripts.some((x) => x.includes(".bak") && x.includes("mv") && !x.startsWith("set -e"))).toBe(true);
  });

  it("restores and reports when the copy fails", async () => {
    const m = machine({ installCode: 1 });
    const { base } = deps(m);
    const a = createAgyAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", CODE, s.state);
    expect(r.ok).toBe(false);
    expect(r.html).toContain("previous one was kept");
  });

  it("refuses a whole URL or prose without touching the child", async () => {
    const m = machine();
    const { base, pty } = deps(m);
    const a = createAgyAdapter(base);
    const s = await a.start("default");
    const r = await a.finish("default", "https://antigravity.google/oauth-callback?code=abc", s.state);
    expect(r.ok).toBe(false);
    expect(pty.writes).toEqual([]);
  });
});

describe("agy login adapter: status", () => {
  it("live check works: free `agy models`, cached for 10 minutes", async () => {
    let now = NOW;
    const m = machine();
    const { base } = deps(m, { now: () => now });
    const a = createAgyAdapter(base);
    const [r] = await a.status();
    expect(r).toMatchObject({ ok: true });
    expect(r!.unverified).toBeUndefined();
    await a.status();
    expect(m.run).toHaveBeenCalledTimes(1);
    now += 11 * 60_000;
    await a.status();
    expect(m.run).toHaveBeenCalledTimes(2);
  });

  it("sign-in answer is reported as rejected", async () => {
    const m = machine({ models: () => ({ code: 1, out: "Please sign in" }) });
    const [r] = await createAgyAdapter(deps(m).base).status();
    expect(r).toMatchObject({ ok: false });
    expect(r!.detail).toContain("/login agy");
  });

  it("when the bot cannot run agy, falls back to the agent-dispatch down flag and says it is not a live check", async () => {
    const m = machine({ models: () => ({ code: null, out: "" }) });
    const flagged = await createAgyAdapter(deps(m, { readDownFlag: async () => ({ cls: "auth", since: "2026-10-03 09:00 UTC" }) }).base).status();
    expect(flagged[0]).toMatchObject({ ok: false });
    expect(flagged[0]!.detail).toContain("since 2026-10-03 09:00 UTC");
    expect(flagged[0]!.detail).toContain("ssh -t founderos-vps");
    const clear = await createAgyAdapter(deps(m).base).status();
    expect(clear[0]!.detail).toContain("not verified live");
    expect(clear[0]).toMatchObject({ ok: true, unverified: true }); // ❔ on the screen, never ✅
    const limit = await createAgyAdapter(deps(m, { readDownFlag: async () => ({ cls: "limit", since: "2026-10-03" }) }).base).status();
    expect(limit[0]!.detail).toContain("not for the login");
    expect(limit[0]).toMatchObject({ unverified: true });
  });

  it("never throws", async () => {
    const m = machine();
    m.run.mockRejectedValue(new Error("boom"));
    const [r] = await createAgyAdapter(deps(m).base).status();
    expect(r!.ok).toBe(false);
  });
});
