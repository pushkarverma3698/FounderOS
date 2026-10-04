import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/infra/logger.js", () => {
  const rec = (): void => undefined;
  return { childLogger: () => ({ info: rec, warn: rec, error: rec, debug: rec }) };
});

import { createClaudeAdapter, type ClaudeLoginDeps, type HostLogin } from "../../../../src/gateway/login/adapters/claude.js";
import { installHostLogin } from "../../../../src/gateway/login/adapters/claude-host-login.js";
import type { LoginFinished } from "../../../../src/gateway/login/types.js";
import { fakePty, osc8 } from "./fake-pty.js";

const TOKEN = `sk-ant-oat01-${"A1b2C3d4".repeat(6)}`;
const CODE = "4/0AX4XfWhSECRETCODE123#statepart";
const URL1 = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=S1";
const URL2 = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Aprofile&state=S2";
const ORG_NEW = "1c2fa9ef-a5be-445f-b662-15c073270325";
const OLD: HostLogin = { email: "old@example.com", org: "942d106e-e724-49f9-a8d6-9b0cc4eaec9c" };
const NEW: HostLogin = { email: "new@example.com", org: ORG_NEW };

let root: string;
let real: string;
let scratch: string;

/** The real HOME as the VPS has it: an old login plus keys that must survive (plugin MCP logins, settings). */
async function seedReal(): Promise<void> {
  await mkdir(join(real, ".claude"), { recursive: true });
  await writeFile(join(real, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "old-a" }, mcpOAuth: { plugin: "keep" } }));
  await writeFile(join(real, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: OLD.email }, numStartups: 9, projects: { "/x": {} } }));
}
/** What `claude auth login` leaves in the scratch HOME on success. */
async function seedScratch(): Promise<void> {
  await mkdir(join(scratch, ".claude"), { recursive: true });
  await writeFile(join(scratch, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "new-a" } }));
  await writeFile(join(scratch, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: NEW.email }, numStartups: 1 }));
}
const readJ = async (p: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "host-login-test-"));
  real = join(root, "real");
  scratch = join(root, "scratch");
  await seedReal();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("installHostLogin", () => {
  it("copies only claudeAiOauth and oauthAccount, keeps every other key, mode 600, and keeps the old files", async () => {
    await seedScratch();
    await installHostLogin(scratch, real, NEW, async () => NEW);
    const creds = await readJ(join(real, ".claude", ".credentials.json"));
    expect(creds).toEqual({ claudeAiOauth: { accessToken: "new-a" }, mcpOAuth: { plugin: "keep" } });
    const cfg = await readJ(join(real, ".claude.json"));
    expect(cfg).toEqual({ oauthAccount: { emailAddress: NEW.email }, numStartups: 9, projects: { "/x": {} } });
    expect((await stat(join(real, ".claude", ".credentials.json"))).mode & 0o777).toBe(0o600);
    expect((await readJ(join(real, ".claude", ".credentials.json.before-login")))["claudeAiOauth"]).toEqual({ accessToken: "old-a" });
  });
  it("puts both files back when claude auth status does not report the new account", async () => {
    await seedScratch();
    await expect(installHostLogin(scratch, real, NEW, async () => OLD)).rejects.toThrow(/did not report the new account/);
    expect((await readJ(join(real, ".claude", ".credentials.json")))["claudeAiOauth"]).toEqual({ accessToken: "old-a" });
    expect((await readJ(join(real, ".claude.json")))["oauthAccount"]).toEqual({ emailAddress: OLD.email });
  });
  it("refuses to touch anything when the scratch login left no credentials", async () => {
    await expect(installHostLogin(scratch, real, NEW, async () => NEW)).rejects.toThrow(/no credentials to copy/);
    expect((await readJ(join(real, ".claude", ".credentials.json")))["claudeAiOauth"]).toEqual({ accessToken: "old-a" });
  });
  it("a server with no login yet gets one; a failed check removes the files it created", async () => {
    await rm(real, { recursive: true });
    await seedScratch();
    await expect(installHostLogin(scratch, real, NEW, async () => undefined)).rejects.toThrow();
    await expect(stat(join(real, ".claude.json"))).rejects.toThrow();
    await installHostLogin(scratch, real, NEW, async () => NEW);
    expect((await readJ(join(real, ".claude.json")))["oauthAccount"]).toEqual({ emailAddress: NEW.email });
  });
});

describe("/login claude step 2", () => {
  /** Two children in order: setup-token (link 1, no token needed: the test pastes a token), then auth login (link 2). */
  function flow(onCode: (feed: (s: string) => void) => void, over: Partial<ClaudeLoginDeps> = {}) {
    const argv: string[][] = [];
    const host = fakePty(osc8(URL2), (t, feed) => {
      if (t === "\r") onCode(feed);
    });
    const homes: string[] = [];
    const deps: Partial<ClaudeLoginDeps> = {
      spawnPty: (a) => {
        argv.push([...a]);
        return host.child;
      },
      verify: async () => ({ kind: "ok" }),
      paths: { primary: join(root, "t1"), dispatch: join(root, "t2") },
      writeTokens: async () => undefined,
      makeHome: async () => {
        homes.push(scratch);
        return { dir: scratch, cleanup: async () => undefined };
      },
      sleep: async () => undefined,
      env: { PATH: "/usr/bin", HOME: real },
      lookupOrg: async () => ({ org: ORG_NEW }),
      hostLogin: async () => OLD,
      readLogin: async (home) => (home === scratch ? NEW : home === real ? NEW : undefined),
      ...over,
    };
    return { adapter: createClaudeAdapter(deps), argv, host };
  }
  async function toStep2(a: ReturnType<typeof flow>["adapter"], hint?: string): Promise<LoginFinished> {
    const s1 = await a.start("default", hint);
    return a.finish("default", TOKEN, s1.state);
  }

  it("runs `claude auth login --claudeai --email <hint>` in a scratch HOME, and a good code moves the server login", async () => {
    const f = flow((feed) => feed("\nLogin successful.\n"));
    const r1 = await toStep2(f.adapter, "new@example.com");
    expect(f.argv[1]).toEqual(["claude", "auth", "login", "--claudeai", "--email", "new@example.com"]);
    await seedScratch(); // what the CLI leaves behind once the code is accepted
    const r2 = await f.adapter.finish("default", CODE, r1.next!.state);
    expect(f.host.writes).toEqual([CODE, "\r"]);
    expect(r2.ok).toBe(true);
    expect(r2.html).toContain("Signed in as new@example.com everywhere");
    expect((await readJ(join(real, ".claude.json")))["oauthAccount"]).toEqual({ emailAddress: NEW.email });
    expect(r2.html).not.toContain(CODE);
  });

  it("the CLI's real refusal text leaves the server login alone and says the token is still saved", async () => {
    const f = flow((feed) => feed("\nLogin failed: Request failed with status code 400\n"));
    const r1 = await toStep2(f.adapter);
    expect(f.argv[1]).toEqual(["claude", "auth", "login", "--claudeai"]);
    const r2 = await f.adapter.finish("default", CODE, r1.next!.state);
    expect(r2.ok).toBe(false);
    expect(r2.html).toContain("refused that code");
    expect(r2.html).toContain("token from step 1 is saved");
    expect((await readJ(join(real, ".claude.json")))["oauthAccount"]).toEqual({ emailAddress: OLD.email });
  });

  it("approving a different account than the token's installs nothing and names the account approved", async () => {
    const f = flow((feed) => feed("\nLogin successful.\n"), { readLogin: async () => OLD });
    const r1 = await toStep2(f.adapter);
    await seedScratch();
    const r2 = await f.adapter.finish("default", CODE, r1.next!.state);
    expect(r2.ok).toBe(false);
    expect(r2.html).toContain(`You approved ${OLD.email}`);
    expect((await readJ(join(real, ".claude", ".credentials.json")))["claudeAiOauth"]).toEqual({ accessToken: "old-a" });
  });

  it("after step 2 the status row says SAME account, with the new email, without a new live check", async () => {
    const verify = vi.fn(async () => ({ kind: "ok" }) as const);
    const f = flow((feed) => feed("\nLogin successful.\n"), {
      verify,
      readFile: async () => ({ state: "ok", token: TOKEN, created: "2026-10-04" }),
    });
    const r1 = await toStep2(f.adapter);
    await seedScratch();
    await f.adapter.finish("default", CODE, r1.next!.state);
    const [row] = await f.adapter.status();
    expect(row!.detail).toContain("same account");
    expect(row!.detail).toContain(NEW.email);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
