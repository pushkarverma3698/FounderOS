/**
 * `/login google <account>`: sign one Gmail/Calendar account in from the phone. Writes the
 * account's own credentials.json (the file gws reads, see gwsEnv) and proves it with a real
 * Gmail call before saying ok. Built-in accounts come from src/core/accounts.ts; `add <name>` signs
 * in any other Google account (his, a second business, someone who forwards him the link) under a
 * name he picks, and `remove <name>` forgets it (src/infra/google-mailboxes.ts).
 */

import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { ACCOUNT_SEED_SPECS, isAccountKey } from "../../../core/accounts.js";
import { listGoogleMailboxes, mailboxNameProblem, mailboxProfileDir } from "../../../infra/google-mailboxes.js";
import { runGws, type GwsRunOutcome } from "../../../infra/gws-runner.js";
import { clearCredentialAlert, isCredentialFailure } from "../../../infra/provider-probes.js";
import { buildAuthAttempt, credentialsFileBody, exchangeCode, parseClientSecret, parsePaste, type AuthAttempt, type OAuthClient } from "../google-oauth.js";
import type { LoginAdapter, LoginFinished, LoginStarted, LoginTargetStatus } from "../types.js";

export interface GoogleLoginDeps {
  readClient(): Promise<OAuthClient>;
  mailboxes(): string[];
  profileDir(account: string): string;
  runGws(args: string[], dir: string): Promise<GwsRunOutcome>;
  doFetch: typeof fetch;
  fileExists(path: string): boolean;
  writeCredentials(path: string, body: string): Promise<void>;
  backup(path: string): Promise<boolean>;
  restore(path: string, hadBackup: boolean): Promise<void>;
  clearAlerts(account: string): void;
  /** Deletes an added mailbox's folder (credentials included). */
  forget(account: string): Promise<void>;
  /** Deletes an account's credentials file and its `.bak`, nothing else. */
  deleteCredentials(path: string): Promise<void>;
}

const esc = (s: string): string => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
const labelOf = (a: string): string => ACCOUNT_SEED_SPECS.find((s) => s.account_key === a)?.display_name ?? a;

function clientSecretPath(): string {
  return process.env["GWS_CLIENT_SECRET_FILE"]?.trim() || `${process.env["HOME"] ?? "/home/founderos"}/.config/gws/client_secret.json`;
}

export const defaultGoogleDeps: GoogleLoginDeps = {
  readClient: async () => parseClientSecret(await readFile(clientSecretPath(), "utf8")),
  mailboxes: () => listGoogleMailboxes(),
  profileDir: (account) => mailboxProfileDir(account),
  runGws: (args, dir) => runGws(args, 30_000, { gwsProfileDir: dir }),
  doFetch: fetch,
  fileExists: existsSync,
  writeCredentials: async (path, body) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.new`;
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    // gws caches the access token per config dir, not per credentials file: keep it and the check reads the old account.
    await rm(`${dirname(path)}/token_cache.json`, { force: true });
  },
  backup: async (path) => (existsSync(path) ? (await copyFile(path, `${path}.bak`), true) : false),
  restore: async (path, hadBackup) => {
    if (hadBackup) await rename(`${path}.bak`, path);
    else await rm(path, { force: true });
  },
  clearAlerts: (account) => {
    clearCredentialAlert("active_gmail", account);
    clearCredentialAlert("active_calendar", account);
  },
  forget: (account) => rm(dirname(mailboxProfileDir(account)), { recursive: true, force: true }),
  deleteCredentials: async (path) => {
    await rm(path, { force: true });
    await rm(`${path}.bak`, { force: true });
  },
};

const PROFILE_ARGS = ["gmail", "users", "getProfile", "--params", JSON.stringify({ userId: "me" })];

function emailOf(outcome: GwsRunOutcome): string | undefined {
  const p = outcome.ok ? (outcome.parsed as { emailAddress?: unknown } | null) : null;
  return typeof p?.emailAddress === "string" ? p.emailAddress : undefined;
}

export function createGoogleAdapter(deps: GoogleLoginDeps): LoginAdapter {
  return {
    id: "google",
    title: "Google (Gmail + Calendar)",
    get targets() {
      return deps.mailboxes();
    },
    addProblem: (name) => (isAccountKey(name) ? undefined : mailboxNameProblem(name)),

    async start(target): Promise<LoginStarted> {
      const client = await deps.readClient();
      const attempt = buildAuthAttempt(client);
      const isNew = !deps.mailboxes().includes(target);
      return {
        state: { client, attempt },
        html:
          (isNew
            ? `<b>Add Google account "${esc(target)}"</b>\n` +
              `Someone else's account: forward them the link, and paste here the address they send back.\n`
            : `<b>Sign in ${esc(labelOf(target))}</b>\n`) +
          `1. Open <a href="${esc(attempt.url)}">this link</a> and choose that Google account.\n` +
          `2. If Google warns the app is unverified: Advanced → Go to the app. It is your own app.\n` +
          `3. After you approve, the page that opens will fail to load (localhost). That is expected. ` +
          `Copy the full address from the browser bar and paste it here.\n\n` +
          `Valid 10 minutes. I delete your paste right away.`,
      };
    },

    async finish(target, pasted, state): Promise<LoginFinished> {
      if (!deps.mailboxes().includes(target) && mailboxNameProblem(target)) return { ok: false, html: `Unknown account ${esc(target)}.` };
      const { client, attempt } = state as { client: OAuthClient; attempt: AuthAttempt };
      const parsed = parsePaste(pasted, attempt.state);
      if (!parsed.ok) return { ok: false, html: `${esc(parsed.reason)}\nPaste again, or /login google ${target} for a new link.` };
      const granted = await exchangeCode(client, parsed.code, attempt.verifier, deps.doFetch);
      if (!granted.ok) return { ok: false, html: esc(granted.reason) };

      const dir = deps.profileDir(target);
      const file = `${dir}/credentials.json`;
      const hadBackup = await deps.backup(file);
      await deps.writeCredentials(file, credentialsFileBody(client, granted.grant));
      const check = await deps.runGws(PROFILE_ARGS, dir);
      const email = emailOf(check);
      if (!email) {
        await deps.restore(file, hadBackup);
        const why = !check.ok && isCredentialFailure(check.error) ? "Google accepted the code but then refused the mailbox." : `Gmail check failed: ${!check.ok ? check.error.slice(0, 160) : "no address returned"}`;
        return { ok: false, html: `${esc(why)}\nThe previous login (if any) was kept.` };
      }
      if (hadBackup) await rm(`${file}.bak`, { force: true });
      deps.clearAlerts(target);
      const use = isAccountKey(target) ? "" : `\nAsk for it by name, e.g. "read ${esc(target)} mail". Sign out: /login google remove ${esc(target)}`;
      return { ok: true, html: `✅ ${esc(labelOf(target))} is signed in as <b>${esc(email)}</b>. Verified with a live Gmail call.${use}` };
    },

    async remove(target): Promise<LoginFinished> {
      if (isAccountKey(target)) {
        return { ok: false, html: `${esc(labelOf(target))} is built in and stays. Renew it with /login google ${target}.` };
      }
      await deps.forget(target);
      deps.clearAlerts(target);
      return {
        ok: true,
        html:
          `Removed "${esc(target)}": FounderOS no longer has its login and the name is gone.\n` +
          `To also cut Google's side, that account can revoke the app at myaccount.google.com/permissions.`,
      };
    },

    async logout(target): Promise<LoginFinished> {
      if (!isAccountKey(target)) return this.remove!(target);
      const dir = deps.profileDir(target);
      await deps.deleteCredentials(`${dir}/credentials.json`);
      // The real failed call: the same Gmail request the sign-in used, against the folder that no longer holds a login.
      const check = await deps.runGws(PROFILE_ARGS, dir);
      const email = emailOf(check);
      if (email) {
        return { ok: false, html: `I deleted ${esc(labelOf(target))}'s login file, but Gmail still answers for ${esc(email)}, so another credential is active for it. It is not signed out.` };
      }
      return {
        ok: true,
        html:
          `${esc(labelOf(target))} is signed out: its login file and backup are deleted, none kept, and a Gmail call now fails.\n` +
          `Mail and calendar for it stop until /login google ${esc(target)}. To also cut Google's side, revoke the app at myaccount.google.com/permissions.`,
      };
    },

    async status(): Promise<readonly LoginTargetStatus[]> {
      return Promise.all(
        deps.mailboxes().map(async (account): Promise<LoginTargetStatus> => {
          const dir = deps.profileDir(account);
          const label = labelOf(account);
          if (!deps.fileExists(`${dir}/credentials.json`)) {
            return { target: account, label, ok: false, detail: `not signed in here — /login google ${account}` };
          }
          const check = await deps.runGws(PROFILE_ARGS, dir);
          const email = emailOf(check);
          if (email) return { target: account, label, ok: true, detail: email };
          const expired = !check.ok && isCredentialFailure(check.error);
          return { target: account, label, ok: false, detail: expired ? `sign-in expired — /login google ${account}` : "could not reach Gmail, try again" };
        }),
      );
    },
  };
}

export const googleAdapter: LoginAdapter = createGoogleAdapter(defaultGoogleDeps);
