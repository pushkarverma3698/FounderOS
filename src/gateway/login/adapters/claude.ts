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
 * header of the free count_tokens call, captured 2026-10-04) is compared with the server's own saved login. When they
 * differ, step 2 (claude-host-login.ts) offers a second link that moves the server's own login to the token's account.
 */

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
import {
  finishHostStep,
  isHostStep,
  readHostLogin,
  startHostStep,
  type HostLogin,
  type ScratchHome,
  type SpawnLike,
} from "./claude-host-login.js";
import type { LoginAdapter, LoginFinished, LoginStarted, LoginTargetStatus } from "../types.js";
import { escHtml, htmlLink, loginEnv, looksLikeCode, sleep, todayUtc } from "../util.js";

import { classifyClaudeResult, probeStoredClaude, signOutClaude, verifyClaudeToken, type TokenCheck } from "./claude-check.js";

export { readHostLogin, type HostLogin } from "./claude-host-login.js";
export { classifyClaudeResult, probeStoredClaude, signOutClaude, verifyClaudeToken, type TokenCheck };

const log = childLogger({ module: "gateway:login:claude" });

const URL_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 45_000;
const STATUS_CACHE_MS = 10 * 60_000;
const PASTE_SETTLE_MS = 300;

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{40,}/;
const TOKEN_ONLY_RE = /^sk-ant-[A-Za-z0-9_-]{40,}$/;
const CLAUDE_HOST_RE = /^https:\/\/claude\.(?:com|ai)\//;
/** What `claude setup-token` prints when the pasted code is refused (captured with a bogus code, 2026-10-04). */
const EXCHANGE_FAILED_RE = /OAuth error|Invalid code|Token exchange failed|Press Enter to retry/;
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

/** One line for the founder: which organization the token is in, and how that relates to the server's own saved login. `effect` adds what each choice means, for the moment right after login. */
export function describeAccount(org: OrgLookup, host: HostLogin | undefined, effect = false): string {
  if ("reason" in org) return `I could not tell which account this is (${org.reason}).`;
  const id = `org ${org.org.slice(0, 8)}`;
  if (!host) return `Account: ${id}. This server has no saved Claude login to compare with.`;
  if (host.org === org.org) return `Account: ${id}, the same account as this server's saved login (${host.email}).`;
  const line = `Account: ${id}, a different account from this server's saved login (${host.email}).`;
  return effect
    ? `${line} pr-brain, the dispatch engine and the bot's executor use the new one; a plain claude run over SSH, or anything run without the token, still uses ${host.email}.`
    : `${line} /login claude <email> moves both to one account.`;
}

// ── the adapter ──────────────────────────────────────────────────────────────

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
  /** `claude auth status` against a given HOME: reads the scratch login in step 2 and the real one after install. */
  readonly readLogin: (home: string) => Promise<HostLogin | undefined>;
  /** Deletes the token files, the server's own login backups, and runs `claude auth logout`. Never throws for a file that is already gone. */
  readonly signOut: () => Promise<{ readonly hostLogout: "ok" | "failed" }>;
  /** The real failed call: claude with only what is stored on disk. */
  readonly probeStored: () => Promise<TokenCheck>;
}

interface ClaudeState {
  readonly child: PtyChild;
  readonly hint?: string;
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
    readLogin: (home) => readHostLogin(undefined, { ...process.env, HOME: home }),
    signOut: () => signOutClaude(paths),
    probeStored: () => probeStoredClaude(),
    ...overrides,
  };
  let cache: { token: string; at: number; check: TokenCheck; account?: string } | undefined;

  /** One lookup, two wordings. Never throws and never fails a login: a broken lookup becomes "could not tell". `moveTo` is set when the server's own login is another account. */
  async function accountLines(token: string): Promise<{ short: string; long: string; moveTo?: string }> {
    try {
      const org = await d.lookupOrg(token);
      const host = await d.hostLogin();
      const moveTo = "org" in org && host?.org !== org.org ? org.org : undefined;
      return { short: describeAccount(org, host), long: describeAccount(org, host, true), moveTo };
    } catch {
      // allow-failopen: identity is advisory; the verified token result stands.
      const m = "I could not tell which account this is.";
      return { short: m, long: m };
    }
  }

  /** Step 2 after a saved token whose account is not the server's own login. A failure to start keeps the token and says so. */
  async function offerHostStep(saved: string, account: { long: string; moveTo?: string }, hint: string | undefined): Promise<LoginFinished> {
    const plain = `${saved} ${escHtml(account.long)}`;
    if (!account.moveTo) return { ok: true, html: `${plain}\n\npr-brain and the Claude dispatch engine read it on their next run; the bot's own Claude executor reads it on its next task.` };
    try {
      const next = await startHostStep(d, account.moveTo, hint);
      return {
        ok: true,
        next,
        html:
          `Step 1 of 2 done. ${saved} pr-brain, the dispatch engine and the bot's executor use it from their next run.\n\n` +
          `Step 2, so this server's own Claude login moves to the same account and I can name it: ${next.html}, in the same private tab. Tap Authorize, then paste the code here.\n` +
          `Skip it and only a plain claude run on the server stays as it is now.`,
      };
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "claude server-login step could not start");
      return { ok: true, html: `${plain}\n\nI could not start the step that moves the server's own login (${escHtml(err instanceof Error ? err.message : String(err))}).` };
    }
  }

  async function complete(token: string, hint?: string): Promise<LoginFinished> {
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
    const saved = `Claude token verified with a real call and saved to <code>${escHtml(d.paths.primary)}</code>${dispatch}${check.note ? ` (${escHtml(check.note)})` : ""}.`;
    return offerHostStep(saved, account, hint);
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
        state: { child, hint } satisfies ClaudeState,
        dispose,
      };
    },

    async finish(_target, pasted, state): Promise<LoginFinished> {
      if (isHostStep(state)) {
        const r = await finishHostStep(d, pasted, state);
        if (r.installed && cache) cache = { ...cache, account: describeAccount({ org: r.installed.org }, r.installed) };
        return { ok: r.ok, html: r.html };
      }
      const text = pasted.trim();
      const hint = (state as ClaudeState | undefined)?.hint;
      if (TOKEN_ONLY_RE.test(text)) return complete(text, hint);

      const child = (state as ClaudeState | undefined)?.child;
      if (!child || child.exited) {
        return { ok: false, ended: true, html: "That sign-in attempt has ended. Send /login claude for a fresh link." };
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
          ended: true,
          html: got
            ? "Claude refused that code (a code works once). Send /login claude for a fresh link."
            : "No token came back within 45 seconds. Send /login claude to try again.",
        };
      }
      return complete(got.token, hint);
    },

    async logout(): Promise<LoginFinished> {
      let out: { readonly hostLogout: "ok" | "failed" };
      try {
        out = await d.signOut();
      } catch (err) {
        log.error({ code: (err as NodeJS.ErrnoException).code ?? "error" }, "claude sign-out could not delete a credential");
        return { ok: false, html: `Could not delete a Claude credential (${escHtml((err as NodeJS.ErrnoException).code ?? "error")}). Some of it may still be in place: check /login.` };
      }
      cache = undefined;
      const left = (await Promise.all([d.paths.primary, d.paths.dispatch].map((p) => d.readFile(p)))).some((r) => r.state !== "missing");
      const probe = await d.probeStored();
      log.info({ hostLogout: out.hostLogout, probe: probe.kind, tokenFileLeft: left }, "claude credentials deleted");
      if (left) return { ok: false, html: "I deleted the Claude token files, but one is still on disk. Check the server." };
      if (probe.kind === "ok") {
        return { ok: false, html: "I deleted the Claude token files, but a test call with only what is stored on this server still works, so a login is still there. It is not signed out." + (out.hostLogout === "failed" ? " <code>claude auth logout</code> failed." : "") };
      }
      const prefix = "Claude is signed out on this server: both token files and the saved login copies are deleted, none kept. ";
      const tail = " pr-brain, the dispatch engine and the bot's Claude executor stop until /login claude. A token made with setup-token stays valid at Anthropic until you revoke it in claude.ai settings.";
      if (probe.kind === "rejected") return { ok: true, html: `${prefix}A test call with what is left on this server was refused, as expected.${tail}` };
      return { ok: true, html: `${prefix}The test call that proves it was refused could not run (${escHtml(probe.reason)}), so that part is not verified.${tail}` };
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
