/**
 * FounderOS — Google Workspace CLI (gws) runner
 * ================================================
 * Thin exec wrapper for the `gws` binary. Used by Gmail read (ADR-028 phase 1)
 * and provider health probes. Never throws — callers map errors to ToolResult.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "util";
import { getGwsBin } from "./provider-config.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "gws-runner" });
const execFileAsync = promisify(execFile);

export interface GwsRunResult {
  ok: true;
  stdout: string;
  parsed: unknown;
}

export interface GwsRunError {
  ok: false;
  error: string;
}

export type GwsRunOutcome = GwsRunResult | GwsRunError;

/** Parse stdout as JSON; returns raw string on parse failure. */
export function parseGwsStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

/**
 * The environment one gws call runs in. gws 0.22 ignores GWS_CONFIG_HOME; it reads
 * GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE for the login and GOOGLE_WORKSPACE_CLI_CONFIG_DIR for its
 * token cache. Both must be per account (ADR-036): with a shared config dir, the first cached token
 * answers for every account (prod 2026-10-08, "work" reported the personal Gmail). An account with no
 * credentials file yet keeps the host's default login rather than failing; `/login google <account>`
 * creates the file.
 */
export function gwsEnv(
  base: NodeJS.ProcessEnv,
  profileDir: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  const env = { ...base };
  if (!profileDir) return env;
  const file = `${profileDir}/credentials.json`;
  env["GOOGLE_APPLICATION_CREDENTIALS"] = env["GOOGLE_APPLICATION_CREDENTIALS"] ?? file;
  if (fileExists(file)) {
    env["GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"] = file;
    env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"] = profileDir;
  } else {
    delete env["GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"];
    delete env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"];
  }
  return env;
}

/**
 * Run a gws subcommand with a timeout. Args are passed after the binary name,
 * e.g. runGws(["gmail", "users", "messages", "list", "--params", "{...}"]).
 */
export async function runGws(
  args: string[],
  timeoutMs = 30_000,
  opts?: { gwsProfileDir?: string },
): Promise<GwsRunOutcome> {
  const bin = getGwsBin();
  const env = gwsEnv(process.env, opts?.gwsProfileDir);
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env,
    });
    if (stderr?.trim()) {
      log.debug({ stderr: stderr.slice(0, 200) }, "gws stderr");
    }
    return { ok: true, stdout, parsed: parseGwsStdout(stdout) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === "ENOENT") {
      return {
        ok: false,
        error: "Gmail is not connected on this host (gws CLI not installed). Install googleworkspace/cli, or run gws auth login.",
      };
    }
    const msg = e.stderr?.trim() || e.message || String(err);
    return { ok: false, error: msg };
  }
}
