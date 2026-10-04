/**
 * /login claude, step 2 — make this server's own saved Claude login follow the token's account.
 *
 * Why: a `setup-token` token can only run models (scope user:inference); it cannot say whose it is. The server's own
 * login (`claude auth login`, ~/.claude) can, and it is what a plain `claude` run uses. When the token's organization
 * differs from that login, the bot offers this second link right after the first; in the same private tab it is one
 * Authorize tap and one paste. Captured against claude 2.1.287 on 2026-10-04: `claude auth login --claudeai --email x`
 * prints an OSC 8 link to claude.com/cai/oauth/authorize, then "Paste code here if prompted >"; a refused code prints
 * "Login failed: Request failed with status code 400". The success path ("Login successful.", exit 0) is read from the
 * binary's strings, not driven live.
 *
 * The login runs in a scratch HOME. Only after its account matches the token's organization are two keys copied into
 * the real files (`claudeAiOauth` in ~/.claude/.credentials.json, `oauthAccount` in ~/.claude.json); every other key
 * (plugin MCP logins, settings) stays. Then `claude auth status` must report the new account, or both files are put back.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { childLogger } from "../../../infra/logger.js";
import { extractHyperlink, stripAnsi, type PtyChild, type SpawnPty } from "../pty-child.js";
import type { LoginFinished, LoginStarted } from "../types.js";
import { escHtml, htmlLink, loginEnv, looksLikeCode } from "../util.js";

const log = childLogger({ module: "gateway:login:claude-host" });

const URL_TIMEOUT_MS = 30_000;
const RESULT_TIMEOUT_MS = 45_000;
const PASTE_SETTLE_MS = 300;
const CLAUDE_HOST_RE = /^https:\/\/claude\.(?:com|ai)\//;
const SUCCESS_RE = /Login successful/;
const FAILED_RE = /Login failed/;

const HOST_LOGIN_TIMEOUT_MS = 15_000;

export type SpawnLike = (cmd: string, args: readonly string[], opts: { env: Record<string, string>; cwd: string; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;

export interface HostLogin {
  readonly email: string;
  readonly org: string;
}

/**
 * The login saved in this server user's own ~/.claude (what a plain `claude` run, or anything without the token, uses).
 * Run with the token and API keys removed so the CLI cannot answer from them. Undefined when there is none.
 */
export async function readHostLogin(spawnFn: SpawnLike = spawn as SpawnLike, base: NodeJS.ProcessEnv = process.env): Promise<HostLogin | undefined> {
  const env = { PATH: base["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: base["HOME"] ?? "", TERM: "xterm-256color" };
  return new Promise<HostLogin | undefined>((resolve) => {
    const child = spawnFn("claude", ["auth", "status", "--json"], { env, cwd: env.HOME || "/", stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    const settle = (r: HostLogin | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(undefined);
    }, HOST_LOGIN_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", () => settle(undefined));
    child.on("close", (code) => {
      if (code !== 0) return settle(undefined);
      try {
        const j = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string; email?: unknown; orgId?: unknown };
        const ok = j.loggedIn === true && j.authMethod === "claude.ai" && typeof j.email === "string" && typeof j.orgId === "string";
        settle(ok ? { email: j.email as string, org: j.orgId as string } : undefined);
      } catch {
        // allow-failopen: unparseable output means no host login to compare with, never a pass or a fail of the token.
        settle(undefined);
      }
    });
  });
}

export interface ScratchHome {
  readonly dir: string;
  cleanup(): Promise<void>;
}

export interface HostStepDeps {
  readonly spawnPty: SpawnPty;
  readonly makeHome: () => Promise<ScratchHome>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly env: NodeJS.ProcessEnv;
  /** `claude auth status` against the given HOME (the scratch one, or the real one after install). */
  readonly readLogin: (home: string) => Promise<HostLogin | undefined>;
}

export interface HostStepState {
  readonly kind: "host";
  readonly child: PtyChild;
  readonly home: ScratchHome;
  readonly tokenOrg: string;
  readonly hint?: string;
}

export const isHostStep = (s: unknown): s is HostStepState => (s as HostStepState | undefined)?.kind === "host";

const redo = (hint: string | undefined): string => `/login claude${hint ? ` ${escHtml(hint)}` : " &lt;email&gt;"}`;

/** Spawns the server-login child and returns its link. Throws when no link appears (the caller keeps the saved token). */
export async function startHostStep(d: HostStepDeps, tokenOrg: string, hint: string | undefined): Promise<LoginStarted & { readonly url: string }> {
  const home = await d.makeHome();
  const child = d.spawnPty(["claude", "auth", "login", "--claudeai", ...(hint ? ["--email", hint] : [])], loginEnv(home.dir, d.env));
  const dispose = async (): Promise<void> => {
    child.kill();
    await home.cleanup();
  };
  const url = await child.waitFor((raw) => extractHyperlink(raw, CLAUDE_HOST_RE), URL_TIMEOUT_MS);
  if (!url) {
    await dispose();
    throw new Error("`claude auth login` printed no sign-in link within 30 seconds");
  }
  log.info({ hinted: hint !== undefined }, "claude server-login link ready");
  return { url, html: htmlLink(url, "open the second link"), state: { kind: "host", child, home, tokenOrg, hint } satisfies HostStepState, dispose };
}

export type HostStepResult = LoginFinished & { readonly installed?: HostLogin };

export async function finishHostStep(d: HostStepDeps, pasted: string, s: HostStepState): Promise<HostStepResult> {
  const saved = "The token from step 1 is saved and working.";
  if (s.child.exited) return { ok: false, html: `That step has ended. ${saved} To move the server's own login too: ${redo(s.hint)}` };
  const code = pasted.trim();
  if (!looksLikeCode(code)) return { ok: false, html: "That does not look like the code from the page (one string, no spaces). Paste it again." };
  s.child.write(code);
  await d.sleep(PASTE_SETTLE_MS); // a TUI reads a burst of text plus Enter as one paste and drops the Enter
  s.child.write("\r");
  const got = await s.child.waitFor((raw) => {
    const t = stripAnsi(raw);
    return SUCCESS_RE.test(t) ? "ok" : FAILED_RE.test(t) ? "failed" : null;
  }, RESULT_TIMEOUT_MS);
  s.child.kill();
  if (got !== "ok") {
    log.warn({ timedOut: got === null }, "claude server login gave no success for the pasted code");
    const why = got ? "Claude refused that code (a code works once)." : "No answer came back within 45 seconds.";
    return { ok: false, html: `${why} ${saved} The server's own login is unchanged. To retry: ${redo(s.hint)}` };
  }
  const scratch = await d.readLogin(s.home.dir);
  if (!scratch) return { ok: false, html: `Claude said the login worked, but I could not read which account it is. ${saved} The server's own login is unchanged.` };
  if (scratch.org !== s.tokenOrg) {
    log.warn({}, "server login approved a different account than the token");
    return {
      ok: false,
      html: `You approved ${escHtml(scratch.email)}, which is not the account the token is in, so the server's own login is unchanged. ${saved} To switch both: ${redo(s.hint)}, in one private tab signed in to that account.`,
    };
  }
  const realHome = d.env["HOME"] ?? "";
  try {
    await installHostLogin(s.home.dir, realHome, scratch, () => d.readLogin(realHome));
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "claude server login could not be installed");
    return { ok: false, html: `The new login could not be installed (${escHtml(err instanceof Error ? err.message : String(err))}). The server's saved login was left as it was. ${saved}` };
  }
  log.info({}, "claude server login now matches the token");
  return {
    ok: true,
    installed: scratch,
    html: `Signed in as ${escHtml(scratch.email)} everywhere: pr-brain, the dispatch engine, the bot's executor and this server's own Claude login.`,
  };
}

// ── install: copy two keys, verify, or put the files back ────────────────────

async function readJson(path: string): Promise<{ text: string | undefined; json: Record<string, unknown> }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { text: undefined, json: {} };
    throw new Error(`${path} could not be read`);
  }
  try {
    return { text, json: JSON.parse(text) as Record<string, unknown> };
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

async function writeSecret(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await chmod(tmp, 0o600); // writeFile's mode is masked by umask and ignored for an existing file
  await rename(tmp, path);
}

/**
 * Copies `claudeAiOauth` and `oauthAccount` from the scratch login into the real one, keeps the old files as
 * `*.before-login` (mode 600), and checks `readReal()` reports `expected`. On any failure both files are restored.
 */
export async function installHostLogin(scratchHome: string, realHome: string, expected: HostLogin, readReal: () => Promise<HostLogin | undefined>): Promise<void> {
  if (!realHome) throw new Error("the bot's HOME is not set");
  const credsPath = join(realHome, ".claude", ".credentials.json");
  const configPath = join(realHome, ".claude.json");
  const oauth = (await readJson(join(scratchHome, ".claude", ".credentials.json"))).json["claudeAiOauth"];
  const account = (await readJson(join(scratchHome, ".claude.json"))).json["oauthAccount"];
  if (!oauth || !account) throw new Error("the new login left no credentials to copy");

  const old = [
    { path: credsPath, ...(await readJson(credsPath)) },
    { path: configPath, ...(await readJson(configPath)) },
  ];
  for (const f of old) if (f.text !== undefined) await writeSecret(`${f.path}.before-login`, f.text);
  try {
    await writeSecret(credsPath, JSON.stringify({ ...old[0]!.json, claudeAiOauth: oauth }, null, 2));
    await writeSecret(configPath, JSON.stringify({ ...old[1]!.json, oauthAccount: account }, null, 2));
    const now = await readReal();
    if (now?.org !== expected.org || now.email !== expected.email) throw new Error("claude auth status did not report the new account afterwards");
  } catch (err) {
    for (const f of old) await (f.text === undefined ? rm(f.path, { force: true }) : writeSecret(f.path, f.text));
    throw err;
  }
}
