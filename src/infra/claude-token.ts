/**
 * The long-lived Claude token (`claude setup-token`) on disk, shared by everything that hands it to a `claude` process.
 *
 *   ~/.claude/pr-brain.token     line 1 token, line 2 creation date YYYY-MM-DD, mode 0600. pr-brain reads it
 *                                (deploy/vps-daemons/pr-brain, TOKEN_FILE); override PR_BRAIN_TOKEN_FILE.
 *   ~/.claude/claude-code.token  line 1 token, mode 0600. agent-dispatch's Claude engine reads it
 *                                (deploy/lib/claude-run.sh); override AGENT_DISPATCH_CLAUDE_TOKEN_FILE.
 *
 * `/login claude` writes both with the same token. The bot's own `claude_code` tool reads the first usable one.
 * A token is a secret: nothing here logs it, and read results carry it only to the caller that asked.
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ClaudeTokenPaths {
  /** pr-brain's file: token + creation date. */
  readonly primary: string;
  /** agent-dispatch's file: token only. */
  readonly dispatch: string;
}

export function claudeTokenPaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): ClaudeTokenPaths {
  return {
    primary: env["PR_BRAIN_TOKEN_FILE"] || join(home, ".claude", "pr-brain.token"),
    dispatch: env["AGENT_DISPATCH_CLAUDE_TOKEN_FILE"] || join(home, ".claude", "claude-code.token"),
  };
}

export type TokenFileRead =
  | { readonly state: "ok"; readonly token: string; /** YYYY-MM-DD from line 2, when present and well-formed. */ readonly created: string | null }
  | { readonly state: "missing" }
  | { readonly state: "empty" }
  | { readonly state: "bad-mode"; readonly mode: string };

/** Reads a token file the way the daemons do: unusable unless the mode is exactly 0600. */
export async function readTokenFile(path: string): Promise<TokenFileRead> {
  let mode: number;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    // allow-failopen: an unreadable or absent file is the "missing" answer, not an error.
    return { state: "missing" };
  }
  if (mode !== 0o600) return { state: "bad-mode", mode: mode.toString(8) };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // allow-failopen: a file that vanished between stat and read is "missing".
    return { state: "missing" };
  }
  const [line1 = "", line2 = ""] = text.split("\n").map((l) => l.replace(/\r$/, "").trim());
  if (!line1) return { state: "empty" };
  return { state: "ok", token: line1, created: /^\d{4}-\d{2}-\d{2}$/.test(line2) ? line2 : null };
}

/** The token the bot's own Claude executor should use: pr-brain's file, else agent-dispatch's. Undefined when neither is usable. */
export async function readClaudeToken(paths: ClaudeTokenPaths = claudeTokenPaths()): Promise<string | undefined> {
  for (const p of [paths.primary, paths.dispatch]) {
    const r = await readTokenFile(p);
    if (r.state === "ok") return r.token;
  }
  return undefined;
}

async function writeSecret(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.new-${process.pid}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await chmod(tmp, 0o600); // writeFile's mode is masked by umask and ignored for an existing file
  await rename(tmp, path);
}

/** Writes both files atomically (temp file + rename, mode 0600). `today` is the creation date, YYYY-MM-DD. */
export async function writeClaudeTokenFiles(token: string, today: string, paths: ClaudeTokenPaths = claudeTokenPaths()): Promise<void> {
  await writeSecret(paths.primary, `${token}\n${today}\n`);
  await writeSecret(paths.dispatch, `${token}\n`);
}

// ── the server's own saved login: when its refresh token stops working ─────────

export type HostExpiryRead =
  | { readonly state: "ok"; readonly expiresAtMs: number }
  | { readonly state: "no-file" }
  | { readonly state: "unreadable" }
  | { readonly state: "no-expiry" }
  | { readonly state: "garbage" };

/**
 * An expiry as epoch milliseconds. Accepts epoch ms, epoch seconds (a number below 1e11 is seconds: as ms it would
 * be before 1973), a string of digits, or an ISO date. Anything else is undefined, never a guess.
 */
export function parseExpiry(raw: unknown): number | undefined {
  if (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim())) raw = Number(raw.trim());
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/**
 * When the refresh token of the server's saved Claude login (`claudeAiOauth` in ~/.claude/.credentials.json, the file
 * /login claude step 2 writes) stops working. Reads ONLY `claudeAiOauth.refreshTokenExpiresAt`: the access and refresh
 * tokens beside it are never copied out, and the result names a state, not file content, so nothing here can leak one.
 */
export async function readHostRefreshExpiry(home: string = homedir()): Promise<HostExpiryRead> {
  let text: string;
  try {
    text = await readFile(join(home, ".claude", ".credentials.json"), "utf8");
  } catch {
    // allow-failopen: no readable file is the "no-file" answer; the caller sends nothing.
    return { state: "no-file" };
  }
  let raw: unknown;
  try {
    const oauth = (JSON.parse(text) as { claudeAiOauth?: { refreshTokenExpiresAt?: unknown } } | null)?.claudeAiOauth;
    raw = oauth?.refreshTokenExpiresAt;
  } catch {
    // allow-failopen: a corrupt file is the "unreadable" answer; the caller sends nothing.
    return { state: "unreadable" };
  }
  if (raw === undefined || raw === null) return { state: "no-expiry" };
  const expiresAtMs = parseExpiry(raw);
  return expiresAtMs === undefined ? { state: "garbage" } : { state: "ok", expiresAtMs };
}
