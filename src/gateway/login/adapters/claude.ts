/**
 * /login claude — renew the long-lived Claude token (`claude setup-token`) from Telegram.
 *
 * Flow (the first two steps and the failure path were driven live against claude 2.1.287; the success path was not):
 *   start   spawn `claude setup-token` behind a pty -> it prints a sign-in URL (an OSC 8 hyperlink) -> send it
 *   finish  he signs in on his phone and pastes the code the page shows -> write it to the child's stdin ->
 *           the child prints the token -> verify it with one cheap real call -> write both token files
 *   fallback  if he pastes a token itself (made with `claude setup-token` on another machine), skip the child
 *           and run the same verification.
 * The token is verified BEFORE it replaces anything on disk. It never reaches a log, a thrown message or `html`.
 *
 * Which account? `setup-token` tokens carry no email (scope user:inference only), so the page cannot be steered and
 * the CLI cannot say whose token it is. Two things cover that: `/login claude <email>` adds `login_hint` to the link
 * (what `claude auth login --email` does), and after login the token's organization id (the `anthropic-organization-id`
 * header of the free count_tokens call, captured 2026-10-04) is compared with the server's own saved login.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childLogger } from "../../../infra/logger.js";
import {
  claudeTokenPaths,
  readTokenFile,
  writeClaudeTokenFiles,
  type ClaudeTokenPaths,
  type TokenFileRead,
} from "../../../infra/claude-token.js";
import { extractHyperlink, spawnPty, stripAnsi, type PtyChild, type SpawnPty } from "../pty-child.js";
import type { LoginAdapter, LoginFinished, LoginStarted, LoginTargetStatus } from "../types.js";
import { escHtml, htmlLink, loginEnv, looksLikeCode, sleep, todayUtc } from "../util.js";

const log = childLogger({ module: "gateway:login:claude" });

const URL_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 45_000;
const VERIFY_TIMEOUT_MS = 60_000;
const STATUS_CACHE_MS = 10 * 60_000;
const PASTE_SETTLE_MS = 300;

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{40,}/;
const TOKEN_ONLY_RE = /^sk-ant-[A-Za-z0-9_-]{40,}$/;
const CLAUDE_HOST_RE = /^https:\/\/claude\.(?:com|ai)\//;
/** What `claude setup-token` prints when the pasted code is refused (captured with a bogus code, 2026-10-04). */
const EXCHANGE_FAILED_RE = /OAuth error|Invalid code|Token exchange failed|Press Enter to retry/;
const HOST_LOGIN_TIMEOUT_MS = 15_000;
const ORG_LOOKUP_TIMEOUT_MS = 15_000;

/** `claude auth login --email` puts the address in the same authorize URL as `login_hint`; setup-token cannot take the flag, so add it here. */
export function withLoginHint(url: string, email: string | undefined): string {
  if (!email) return url;
  const u = new URL(url);
  u.searchParams.set("login_hint", email);
  return u.toString();
}

// ── which account is this token? ─────────────────────────────────────────────

export type OrgLookup = { readonly org: string } | { readonly reason: string };

/**
 * The token's organization id, from the response header of the free count_tokens call. The header is present on any
 * authenticated response (even a 404 for an unknown model, captured 2026-10-04) and absent on a 401. The token goes
 * only to api.anthropic.com, where every `claude` call sends it anyway. The result never carries the token.
 */
export async function lookupOrgId(token: string, fetchFn: typeof fetch = fetch): Promise<OrgLookup> {
  try {
    const res = await fetchFn("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(ORG_LOOKUP_TIMEOUT_MS),
    });
    const org = res.headers.get("anthropic-organization-id");
    return org ? { org } : { reason: `no organization in the reply (HTTP ${res.status})` };
  } catch {
    // allow-failopen: identity is advisory; the caller says "could not tell which account" and the verified login stands.
    return { reason: "the lookup could not reach Anthropic" };
  }
}

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

/** One line for the founder: which organization the token is in, and how that relates to the server's own saved login. `effect` adds what each choice means, for the moment right after login. */
export function describeAccount(org: OrgLookup, host: HostLogin | undefined, effect = false): string {
  if ("reason" in org) return `I could not tell which account this is (${org.reason}).`;
  const id = `org ${org.org.slice(0, 8)}`;
  if (!host) return `Account: ${id}. This server has no saved Claude login to compare with.`;
  if (host.org === org.org) return `Account: ${id}, the same account as this server's saved login (${host.email}).`;
  const line = `Account: ${id}, a different account from this server's saved login (${host.email}).`;
  return effect
    ? `${line} pr-brain, the dispatch engine and the bot's executor use the new one; a plain claude run over SSH, or anything run without the token, still uses ${host.email}.`
    : line;
}

// ── the cheap real call ──────────────────────────────────────────────────────

export type TokenCheck =
  | { readonly kind: "ok"; readonly note?: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Reads `claude -p --output-format json`. Captured: a made-up token gives exit 1 and
 * {"is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 OAuth access token is invalid."}.
 * Never copies claude's text into the result: only fixed phrases.
 */
export function classifyClaudeResult(stdout: string, exitCode: number | null): TokenCheck {
  let j: { is_error?: boolean; api_error_status?: number | null; result?: unknown } | undefined;
  try {
    j = JSON.parse(stdout) as typeof j;
  } catch {
    // allow-failopen: unparseable output is the "unknown" answer below, never a pass.
    j = undefined;
  }
  if (!j || typeof j !== "object") return { kind: "unknown", reason: `claude exited ${exitCode ?? "without a code"} with no JSON result` };
  if (j.is_error === false) return { kind: "ok" };
  const text = typeof j.result === "string" ? j.result : "";
  if (j.api_error_status === 401 || j.api_error_status === 403 || /failed to authenticate|oauth token (has )?(expired|invalid)|not logged in/i.test(text)) {
    return { kind: "rejected" };
  }
  if (/hit your .*limit|usage limit/i.test(text)) return { kind: "ok", note: "the token works but the usage limit is reached" };
  return { kind: "unknown", reason: `claude returned an error (status ${j.api_error_status ?? "none"})` };
}

type SpawnLike = (cmd: string, args: readonly string[], opts: { env: Record<string, string>; cwd: string; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;

/** One `claude -p "reply ok" --max-turns 1` with ONLY this token, from an empty HOME so no other login can answer for it. */
export async function verifyClaudeToken(token: string, spawnFn: SpawnLike = spawn as SpawnLike, base: NodeJS.ProcessEnv = process.env): Promise<TokenCheck> {
  const home = await mkdtemp(join(tmpdir(), "claude-verify-"));
  try {
    return await new Promise<TokenCheck>((resolve) => {
      const env = { ...loginEnv(home, base), CLAUDE_CODE_OAUTH_TOKEN: token };
      const child = spawnFn("claude", ["-p", "reply ok", "--max-turns", "1", "--output-format", "json"], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let settled = false;
      const settle = (r: TokenCheck): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle({ kind: "unknown", reason: "the check timed out" });
      }, VERIFY_TIMEOUT_MS);
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.on("error", () => settle({ kind: "unknown", reason: "the claude binary could not be started" }));
      child.on("close", (code) => settle(classifyClaudeResult(out, code)));
    });
  } finally {
    // allow-failopen: a leftover empty scratch dir in /tmp is harmless and must not mask the verdict.
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── the adapter ──────────────────────────────────────────────────────────────

interface ScratchHome {
  readonly dir: string;
  cleanup(): Promise<void>;
}

export interface ClaudeLoginDeps {
  readonly spawnPty: SpawnPty;
  readonly verify: (token: string) => Promise<TokenCheck>;
  readonly paths: ClaudeTokenPaths;
  readonly readFile: (path: string) => Promise<TokenFileRead>;
  readonly writeTokens: (token: string, today: string) => Promise<void>;
  readonly makeHome: () => Promise<ScratchHome>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly env: NodeJS.ProcessEnv;
  readonly lookupOrg: (token: string) => Promise<OrgLookup>;
  readonly hostLogin: () => Promise<HostLogin | undefined>;
}

interface ClaudeState {
  readonly child: PtyChild;
}

const realMakeHome = async (): Promise<ScratchHome> => {
  const dir = await mkdtemp(join(tmpdir(), "claude-login-"));
  // allow-failopen: a leftover scratch dir in /tmp is harmless.
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined) };
};

export function createClaudeAdapter(overrides: Partial<ClaudeLoginDeps> = {}): LoginAdapter {
  const paths = overrides.paths ?? claudeTokenPaths();
  const d: ClaudeLoginDeps = {
    spawnPty,
    verify: (t) => verifyClaudeToken(t),
    paths,
    readFile: readTokenFile,
    writeTokens: (t, today) => writeClaudeTokenFiles(t, today, paths),
    makeHome: realMakeHome,
    now: Date.now,
    sleep,
    env: process.env,
    lookupOrg: (t) => lookupOrgId(t),
    hostLogin: () => readHostLogin(undefined, process.env),
    ...overrides,
  };
  let cache: { token: string; at: number; check: TokenCheck; account?: string } | undefined;

  /** One lookup, two wordings. Never throws and never fails a login: a broken lookup becomes "could not tell". */
  async function accountLines(token: string): Promise<{ short: string; long: string }> {
    try {
      const org = await d.lookupOrg(token);
      const host = await d.hostLogin();
      return { short: describeAccount(org, host), long: describeAccount(org, host, true) };
    } catch {
      // allow-failopen: identity is advisory; the verified token result stands.
      const m = "I could not tell which account this is.";
      return { short: m, long: m };
    }
  }

  async function complete(token: string): Promise<LoginFinished> {
    const check = await d.verify(token);
    if (check.kind === "rejected") {
      log.warn({}, "claude token rejected by the verification call");
      return { ok: false, html: "Claude issued a token, but a test call with it was rejected. Nothing was saved. Send /login claude to start over." };
    }
    if (check.kind === "unknown") {
      log.warn({ reason: check.reason }, "claude token could not be verified");
      return { ok: false, html: `I could not verify the token (${escHtml(check.reason)}), so nothing was saved. Try again in a minute.` };
    }
    try {
      await d.writeTokens(token, todayUtc(d.now()));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      log.error({ code }, "claude token verified but could not be written");
      return { ok: false, html: `The token works but writing it failed (${escHtml(String(code))}). Nothing was changed.` };
    }
    const account = await accountLines(token);
    cache = { token, at: d.now(), check, account: account.short };
    log.info({ note: check.note }, "claude token verified and stored");
    const dispatch = d.paths.dispatch === d.paths.primary ? "" : `, <code>${escHtml(d.paths.dispatch)}</code>`;
    return {
      ok: true,
      html: `Claude token verified with a real call and saved to <code>${escHtml(d.paths.primary)}</code>${dispatch}${check.note ? ` (${escHtml(check.note)})` : ""}. ${escHtml(account.long)}\n\npr-brain and the Claude dispatch engine read it on their next run; the bot's own Claude executor reads it on its next task.`,
    };
  }

  return {
    id: "claude",
    title: "Claude Code (long-lived token)",
    targets: ["default"],

    acceptsEmailHint: true,

    async start(_target, hint): Promise<LoginStarted> {
      const home = await d.makeHome();
      const child = d.spawnPty(["claude", "setup-token"], loginEnv(home.dir, d.env));
      const dispose = async (): Promise<void> => {
        child.kill();
        await home.cleanup();
      };
      const url = await child.waitFor((raw) => extractHyperlink(raw, CLAUDE_HOST_RE), URL_TIMEOUT_MS);
      if (!url) {
        await dispose();
        log.warn({ exited: child.exited }, "claude setup-token printed no sign-in link");
        throw new Error("`claude setup-token` did not print a sign-in link within 30 seconds (is `claude` installed for the bot's user?)");
      }
      log.info({ hinted: hint !== undefined }, "claude sign-in link ready");
      return {
        html:
          `Sign in to Claude${hint ? ` as ${escHtml(hint)}` : ""}: ${htmlLink(withLoginHint(url, hint), "open the sign-in page")}\n\n` +
          "Open it in a private tab: the page signs in whichever Claude account that browser already has, and I cannot change that from here.\n" +
          "Approve it, copy the code the page shows, and paste it here as your next message (valid 10 minutes). I delete your message after reading it.\n" +
          "Alternative: run <code>claude setup-token</code> on your laptop and paste the token it prints.",
        state: { child } satisfies ClaudeState,
        dispose,
      };
    },

    async finish(_target, pasted, state): Promise<LoginFinished> {
      const text = pasted.trim();
      if (TOKEN_ONLY_RE.test(text)) return complete(text);

      const child = (state as ClaudeState | undefined)?.child;
      if (!child || child.exited) {
        return { ok: false, html: "That sign-in attempt has ended. Send /login claude for a fresh link." };
      }
      if (!looksLikeCode(text)) {
        return { ok: false, html: "That does not look like the code from the sign-in page (one string, no spaces). Paste it again, or /login claude for a fresh link." };
      }
      child.write(text);
      await d.sleep(PASTE_SETTLE_MS); // a TUI reads a burst of text plus Enter as one paste and drops the Enter
      child.write("\r");
      const got = await child.waitFor((raw) => {
        const s = stripAnsi(raw);
        const m = TOKEN_RE.exec(s);
        if (m) return { token: m[0] } as const;
        return EXCHANGE_FAILED_RE.test(s) ? ({ failed: true } as const) : null;
      }, TOKEN_TIMEOUT_MS);
      child.kill();
      if (!got || "failed" in got) {
        log.warn({ timedOut: !got }, "claude setup-token gave no token for the pasted code");
        return {
          ok: false,
          html: got
            ? "Claude refused that code (a code works once). Send /login claude for a fresh link."
            : "No token came back within 45 seconds. Send /login claude to try again.",
        };
      }
      return complete(got.token);
    },

    async status(): Promise<readonly LoginTargetStatus[]> {
      const row = (ok: boolean, detail: string): readonly LoginTargetStatus[] => [{ target: "default", label: "Claude Code", ok, detail }];
      try {
        const f = await d.readFile(d.paths.primary);
        if (f.state === "missing") return row(false, "never set");
        if (f.state === "empty") return row(false, `${d.paths.primary} is empty`);
        if (f.state === "bad-mode") return row(false, `${d.paths.primary} has mode ${f.mode}, not 600: ignored`);
        const when = f.created ? `token from ${f.created}` : "token with no date";
        let check: TokenCheck;
        let account: string | undefined;
        if (cache && cache.token === f.token && d.now() - cache.at < STATUS_CACHE_MS) {
          check = cache.check;
          account = cache.account;
        } else {
          check = await d.verify(f.token);
          if (check.kind === "ok") account = (await accountLines(f.token)).short;
          if (check.kind !== "unknown") cache = { token: f.token, at: d.now(), check, account };
        }
        const dispatch = await d.readFile(d.paths.dispatch);
        const dispatchNote = dispatch.state === "ok" && dispatch.token === f.token ? "" : "; the dispatch token file is missing or different: /login claude fixes it";
        if (check.kind === "ok") return row(true, `${when}, works${check.note ? ` (${check.note})` : ""}${account ? `. ${account}` : ""}${dispatchNote}`);
        if (check.kind === "rejected") return row(false, `${when}, rejected: /login claude`);
        return row(false, `${when}, could not be checked (${check.reason})`);
      } catch (err) {
        // allow-failopen: the status screen must show the other tools even when this one breaks.
        return row(false, `status check failed (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      }
    },
  };
}

export const claudeAdapter: LoginAdapter = createClaudeAdapter();
