/**
 * The real calls /login claude makes against the `claude` CLI: the one that proves a token works, and the one
 * that proves a sign-out worked. Split from claude.ts to keep that file under the line budget.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeTokenPaths } from "../../../infra/claude-token.js";
import type { SpawnLike } from "./claude-host-login.js";
import { loginEnv } from "../util.js";

const VERIFY_TIMEOUT_MS = 60_000;

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

/** One `claude -p "reply ok" --max-turns 1` in `env`, from `cwd`. Never reads or returns claude's text beyond `classifyClaudeResult`. */
async function runClaudeProbe(env: Record<string, string>, cwd: string, spawnFn: SpawnLike): Promise<TokenCheck> {
  return new Promise<TokenCheck>((resolve) => {
    const child = spawnFn("claude", ["-p", "reply ok", "--max-turns", "1", "--output-format", "json"], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
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
}

/** One `claude -p "reply ok" --max-turns 1` with ONLY this token, from an empty HOME so no other login can answer for it. */
export async function verifyClaudeToken(token: string, spawnFn: SpawnLike = spawn as SpawnLike, base: NodeJS.ProcessEnv = process.env): Promise<TokenCheck> {
  const home = await mkdtemp(join(tmpdir(), "claude-verify-"));
  try {
    return await runClaudeProbe({ ...loginEnv(home, base), CLAUDE_CODE_OAUTH_TOKEN: token }, home, spawnFn);
  } finally {
    // allow-failopen: a leftover empty scratch dir in /tmp is harmless and must not mask the verdict.
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The same call with the bot's own HOME and no token variables: what claude does when it has only what is stored on disk.
 * After a logout that must fail. A key in the environment is stripped so it cannot answer for the login being tested.
 */
export async function probeStoredClaude(spawnFn: SpawnLike = spawn as SpawnLike, base: NodeJS.ProcessEnv = process.env): Promise<TokenCheck> {
  const cwd = await mkdtemp(join(tmpdir(), "claude-probe-"));
  try {
    const env = loginEnv(base["HOME"] ?? "", base);
    return await runClaudeProbe(env, cwd, spawnFn);
  } finally {
    // allow-failopen: a leftover empty scratch dir in /tmp is harmless and must not mask the verdict.
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Deletes every stored Claude credential this server holds: both token files, the `*.before-login` copies a server-login
 * move leaves behind (they hold the old login), and the server user's own login through `claude auth logout`.
 * Anthropic's side is not touched: a `setup-token` token stays valid there until it is revoked in claude.ai settings.
 */
export async function signOutClaude(paths: ClaudeTokenPaths, spawnFn: SpawnLike = spawn as SpawnLike, base: NodeJS.ProcessEnv = process.env): Promise<{ readonly hostLogout: "ok" | "failed" }> {
  const home = base["HOME"] ?? "";
  const files = [paths.primary, paths.dispatch];
  if (home) files.push(join(home, ".claude", ".credentials.json.before-login"), join(home, ".claude.json.before-login"));
  for (const f of files) await rm(f, { force: true });
  const hostLogout = await new Promise<"ok" | "failed">((resolve) => {
    const env = loginEnv(home, base);
    const child = spawnFn("claude", ["auth", "logout"], { env, cwd: home || "/", stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("failed");
    }, VERIFY_TIMEOUT_MS);
    child.on("error", () => (clearTimeout(timer), resolve("failed")));
    child.on("close", (code) => (clearTimeout(timer), resolve(code === 0 ? "ok" : "failed")));
  });
  return { hostLogout };
}
