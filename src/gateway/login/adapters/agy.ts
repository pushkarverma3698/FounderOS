/**
 * /login agy — renew the Antigravity CLI login from Telegram.
 *
 * What was driven live (agy 1.2.14 on founderos-vps, in a scratch HOME so the working login was never touched):
 *   - agy logs in only from its TUI: Enter on "1. Google OAuth" -> a sign-in link (OSC 8 hyperlink to
 *     accounts.google.com, redirect https://antigravity.google/oauth-callback) -> a "paste the authorization code" prompt.
 *     So paste-back IS possible: no localhost callback is involved.
 *   - A lone `<HOME>/.gemini/antigravity-cli/antigravity-oauth-token` in an empty HOME is a complete login.
 *   - `agy models` is a free auth check (no model call); not logged in it says "Please sign in...".
 * Not driven live: accepting a real code (needs the founder's Google consent) and so the file landing after the paste.
 *
 * Production constraint (checked on the VPS): agy lives in /home/antigravity (mode 750) and can only be run through
 * `sudo -u antigravity`, but the bot's systemd unit sets NoNewPrivileges=yes, so sudo fails inside the bot. Every agy
 * operation therefore goes through ONE runner (`run`), optionally prefixed with `sudo -n -i -u $AGY_LOGIN_USER`.
 * Unset (the default), it runs agy as the bot's own user. When agy cannot be reached, `start` says so with the ssh
 * command and `status` falls back to the agent-dispatch down flag. The credentials are never read into this process:
 * the new login is built in a scratch HOME, proved there with `agy models`, and only then copied over the live file
 * (old one kept as .bak and restored if the live check rejects the new one).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { childLogger } from "../../../infra/logger.js";
import { extractHyperlink, spawnPty, stripAnsi, type SpawnPty } from "../pty-child.js";
import type { LoginAdapter, LoginFinished, LoginStarted, LoginTargetStatus } from "../types.js";
import { escHtml, htmlLink, loginEnv, looksLikeCode, sleep } from "../util.js";

const log = childLogger({ module: "gateway:login:agy" });

const MENU_TIMEOUT_MS = 20_000;
const URL_TIMEOUT_MS = 20_000;
const LOGIN_POLL_MS = 1_000;
const LOGIN_POLL_MAX = 45;
const RUN_TIMEOUT_MS = 30_000;
const STATUS_CACHE_MS = 10 * 60_000;
const PASTE_SETTLE_MS = 300;

const TOKEN_REL = ".gemini/antigravity-cli/antigravity-oauth-token";
const GOOGLE_HOST_RE = /^https:\/\/accounts\.google\.com\//;
const SIGN_IN_RE = /please sign in|sign in to|not (?:logged|signed) in|log ?in required/i;
const SAFE_PATH_RE = /^\/[A-Za-z0-9_./-]{1,200}$/;

export interface RunResult {
  /** null when the process could not be started (ENOENT, EACCES). */
  readonly code: number | null;
  /** stdout + stderr. For `agy models` and file tests only: never a credential. */
  readonly out: string;
}
export type Run = (argv: readonly string[], timeoutMs: number) => Promise<RunResult>;

export type AgyProbe = { kind: "ok" } | { kind: "rejected" } | { kind: "unavailable"; reason: string };

export function classifyAgyModels(r: RunResult, viaSudo: boolean): AgyProbe {
  if (SIGN_IN_RE.test(r.out)) return { kind: "rejected" };
  if (r.code === 0) return { kind: "ok" };
  if (r.code === null) return { kind: "unavailable", reason: "the agy binary could not be started" };
  if (viaSudo && /sudo:|no new privileges|password is required/i.test(r.out)) {
    return { kind: "unavailable", reason: "sudo to the agy user is not allowed from the bot (NoNewPrivileges)" };
  }
  return { kind: "unavailable", reason: `agy models exited ${r.code}` };
}

export interface AgyLoginDeps {
  readonly spawnPty: SpawnPty;
  readonly run: Run;
  /** `sudo -n -i -u <user>` when set. */
  readonly user: string | undefined;
  readonly agyBin: string;
  readonly readDownFlag: () => Promise<{ cls: string; since: string } | null>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly env: NodeJS.ProcessEnv;
}

const realRun: Run = (argv, timeoutMs) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) return resolve({ code: null, out: "" });
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20, env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env["HOME"] ?? homedir() } }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      if (!err) return resolve({ code: 0, out });
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve({ code: typeof code === "number" ? code : null, out });
    });
  });

async function realReadDownFlag(): Promise<{ cls: string; since: string } | null> {
  try {
    const [cls = "", since = ""] = (await readFile(join(process.env["HOME"] ?? homedir(), ".claude", "agent-dispatch.down"), "utf8")).split("\n");
    return { cls: cls.trim(), since: since.trim() };
  } catch {
    // allow-failopen: no readable down flag means "nothing flagged", which status words as unverified.
    return null;
  }
}

const SSH_HINT =
  "Renew it by hand: ssh -t founderos-vps 'sudo -u antigravity -i agy', press Enter on 1. Google OAuth, open the link, paste the code. Then delete ~/.claude/agent-dispatch.down if it exists.";

interface AgyState {
  readonly dir: string;
  readonly child: ReturnType<SpawnPty>;
}

export function createAgyAdapter(overrides: Partial<AgyLoginDeps> = {}): LoginAdapter {
  const env = overrides.env ?? process.env;
  const d: AgyLoginDeps = {
    spawnPty,
    run: realRun,
    user: env["AGY_LOGIN_USER"]?.trim() || undefined,
    agyBin: env["AGY_BIN"]?.trim() || "agy",
    readDownFlag: realReadDownFlag,
    now: Date.now,
    sleep,
    env,
    ...overrides,
  };
  let cache: { at: number; probe: AgyProbe } | undefined;

  const asUser = (argv: readonly string[]): string[] => (d.user ? ["sudo", "-n", "-i", "-u", d.user, ...argv] : [...argv]);
  const sh = (script: string): Promise<RunResult> => d.run(asUser(["sh", "-c", script]), RUN_TIMEOUT_MS);
  const agyModelsIn = (dir: string | null): Promise<RunResult> =>
    sh(`${dir ? `HOME='${dir}' ` : ""}${d.agyBin} models 2>&1`);

  async function probeLive(): Promise<AgyProbe> {
    if (cache && d.now() - cache.at < STATUS_CACHE_MS) return cache.probe;
    const probe = classifyAgyModels(await agyModelsIn(null), Boolean(d.user));
    if (probe.kind !== "unavailable") cache = { at: d.now(), probe };
    return probe;
  }

  async function cleanup(dir: string): Promise<void> {
    // allow-failopen: a leftover scratch HOME (mode 700, its own user) is harmless and must not mask the real outcome.
    await sh(`rm -rf -- '${dir}'`).catch(() => undefined);
  }

  async function install(dir: string): Promise<{ ok: boolean; reason?: string }> {
    const live = `"$HOME/${TOKEN_REL}"`;
    const script = [
      "set -e",
      `d=$(dirname ${live})`,
      'mkdir -p "$d" && chmod 700 "$d"',
      `[ -f ${live} ] && cp -p ${live} ${live}.bak || true`,
      `cp '${dir}/${TOKEN_REL}' ${live}.new`,
      `chmod 600 ${live}.new`,
      `mv ${live}.new ${live}`,
    ].join("; ");
    const r = await sh(script);
    return r.code === 0 ? { ok: true } : { ok: false, reason: `copy exited ${r.code ?? "without a code"}` };
  }

  async function restore(): Promise<void> {
    const live = `"$HOME/${TOKEN_REL}"`;
    // allow-failopen: nothing more can be done if the restore itself fails; the caller already reports the failure.
    await sh(`[ -f ${live}.bak ] && mv ${live}.bak ${live} || true`).catch(() => undefined);
  }

  return {
    id: "agy",
    title: "Antigravity (agy)",
    targets: ["default"],

    async start(): Promise<LoginStarted> {
      const mk = await sh("mktemp -d");
      const dir = mk.out.trim().split("\n").pop() ?? "";
      if (mk.code !== 0 || !SAFE_PATH_RE.test(dir)) {
        const reason = d.user ? "sudo to the agy user is refused for the bot (its systemd unit sets NoNewPrivileges=yes)" : "no runnable agy for the bot's user";
        log.warn({ code: mk.code, viaSudo: Boolean(d.user) }, "agy login cannot start from the bot");
        throw new Error(`agy is not reachable from the bot (${reason}). ${SSH_HINT}`);
      }
      const child = d.spawnPty(asUser(["env", `HOME=${dir}`, "TERM=xterm-256color", d.agyBin]), loginEnv(dir, d.env));
      const dispose = async (): Promise<void> => {
        child.kill();
        await cleanup(dir);
      };
      const seen = await child.waitFor((raw) => {
        const url = extractHyperlink(raw, GOOGLE_HOST_RE);
        if (url) return { url } as const;
        return /Google OAuth/.test(stripAnsi(raw)) ? ({ menu: true } as const) : null;
      }, MENU_TIMEOUT_MS);
      let url = seen && "url" in seen ? seen.url : null;
      if (seen && "menu" in seen) {
        await d.sleep(PASTE_SETTLE_MS);
        child.write("\r"); // Enter on "1. Google OAuth"
        url = await child.waitFor((raw) => extractHyperlink(raw, GOOGLE_HOST_RE), URL_TIMEOUT_MS);
      }
      if (!url) {
        await dispose();
        log.warn({ sawMenu: Boolean(seen) }, "agy printed no sign-in link");
        throw new Error(`agy did not show a sign-in link (${seen ? "the menu appeared but no link followed" : "no menu appeared"}). ${SSH_HINT}`);
      }
      log.info({}, "agy sign-in link ready");
      return {
        html:
          `Sign in to Antigravity: ${htmlLink(url, "open the sign-in page")}\n\n` +
          "Approve it with the Google account agy uses, copy the authorization code the page shows, and paste it here as your next message (valid 10 minutes). I delete your message after reading it.\n" +
          "The current agy login stays in place until the new one is proved.",
        state: { dir, child } satisfies AgyState,
        dispose,
      };
    },

    async finish(_target, pasted, state): Promise<LoginFinished> {
      const st = state as AgyState | undefined;
      if (!st || st.child.exited) return { ok: false, html: "That sign-in attempt has ended. Send /login agy for a fresh link." };
      const code = pasted.trim();
      if (!looksLikeCode(code)) {
        return { ok: false, html: "That does not look like the authorization code (one string, no spaces, not the whole URL). Paste just the code, or /login agy for a fresh link." };
      }
      st.child.write(code);
      await d.sleep(PASTE_SETTLE_MS);
      st.child.write("\r");

      let landed = false;
      for (let i = 0; i < LOGIN_POLL_MAX && !landed; i++) {
        landed = (await sh(`test -s '${st.dir}/${TOKEN_REL}'`)).code === 0;
        if (!landed) {
          if (st.child.exited) break;
          await d.sleep(LOGIN_POLL_MS);
        }
      }
      st.child.kill();
      if (!landed) {
        log.warn({}, "agy wrote no login after the pasted code");
        return { ok: false, html: "agy did not produce a login after that code (expired, used already, or wrong account?). Your current agy login is untouched. Send /login agy for a fresh link." };
      }

      const proof = classifyAgyModels(await agyModelsIn(st.dir), Boolean(d.user));
      if (proof.kind !== "ok") {
        log.warn({ kind: proof.kind }, "new agy login failed its check in the scratch HOME");
        return { ok: false, html: "agy wrote a login but `agy models` did not accept it. Nothing was replaced; your current agy login is untouched." };
      }
      const put = await install(st.dir);
      if (!put.ok) {
        log.error({ reason: put.reason }, "agy login verified but could not be installed");
        await restore();
        return { ok: false, html: `The new login works but installing it failed (${escHtml(put.reason ?? "unknown")}). The previous one was kept.` };
      }
      cache = undefined;
      const live = await probeLive();
      if (live.kind === "rejected") {
        await restore();
        cache = undefined;
        return { ok: false, html: "The new login passed in a scratch HOME but was rejected once installed. The previous login was restored." };
      }
      log.info({ liveCheck: live.kind }, "agy login installed");
      return {
        ok: true,
        html:
          "agy login verified with <code>agy models</code> and installed" +
          (live.kind === "ok" ? ", and the live account answers." : ` (the live re-check could not run: ${escHtml(live.reason)}).`) +
          " If agent-dispatch had paused on a login failure, it resumes on its next tick or delete ~/.claude/agent-dispatch.down.",
      };
    },

    async status(): Promise<readonly LoginTargetStatus[]> {
      const row = (ok: boolean, detail: string): readonly LoginTargetStatus[] => [{ target: "default", label: "Antigravity (agy)", ok, detail }];
      try {
        const probe = await probeLive();
        if (probe.kind === "ok") return row(true, "agy models answers: login works");
        if (probe.kind === "rejected") return row(false, "agy says sign in: /login agy");
        const flag = await d.readDownFlag();
        if (flag?.cls === "auth") return row(false, `agent-dispatch flagged the agy login rejected since ${flag.since}; ${SSH_HINT}`);
        if (flag) return row(true, `agent-dispatch is paused (${flag.cls}) since ${flag.since}, not for the login; live check unavailable from the bot (${probe.reason})`);
        return row(true, `no login failure flagged by agent-dispatch; not verified live from the bot (${probe.reason})`);
      } catch (err) {
        // allow-failopen: the status screen must show the other tools even when this one breaks.
        return row(false, `status check failed (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      }
    },
  };
}

export const agyAdapter: LoginAdapter = createAgyAdapter();
