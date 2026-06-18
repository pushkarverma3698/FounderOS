/**
 * FounderOS — Google Workspace CLI (gws) runner
 * ================================================
 * Thin exec wrapper for the `gws` binary. Used by Gmail read (ADR-028 phase 1)
 * and provider health probes. Never throws — callers map errors to ToolResult.
 */

import { execFile } from "node:child_process";
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
 * Run a gws subcommand with a timeout. Args are passed after the binary name,
 * e.g. runGws(["gmail", "users", "messages", "list", "--params", "{...}"]).
 */
export async function runGws(
  args: string[],
  timeoutMs = 30_000,
): Promise<GwsRunOutcome> {
  const bin = getGwsBin();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
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
        error: "Gmail is not connected on this host (gws CLI not installed). Install googleworkspace/cli, run gws auth login, or set GMAIL_BACKEND=composio.",
      };
    }
    const msg = e.stderr?.trim() || e.message || String(err);
    return { ok: false, error: msg };
  }
}
