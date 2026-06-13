/**
 * FounderOS — Global Halt (Kill Switch)
 * =====================================
 * Why: the founder needs a single, instant way to stop FounderOS from acting —
 * before a deploy, when something looks wrong, or to freeze all outbound work.
 * When halted, every NEW turn is refused at the gateway entry point, before any
 * office work or side effect runs.
 *
 * Design: a flag FILE is the source of truth (presence = halted). This fits the
 * single-instance bot (PID-locked) and adds NO boot/runtime dependency — unlike a
 * Redis key it can never fail-open if a cache is down. The file holds JSON metadata
 * (reason/when/who) purely for the notice shown to the founder.
 *
 * Limitation (documented, not overclaimed): the gateway checks this at turn entry,
 * so it blocks new turns; it does NOT abort an in-flight LLM call. Turns are
 * seconds-long and the budget guard (src/infra/budget.ts) caps runaway loops, so
 * this is the pragmatic stop for a single-instance bot. See docs/PRODUCTION.md.
 *
 * Failure mode: fail-SAFE, never fail-open. A present-but-corrupt flag is still
 * treated as halted. A transient read error (not ENOENT) is logged loudly and
 * treated as not-halted so a flaky filesystem can't permanently brick the bot.
 */

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.js";

const log = logger.child({ module: "halt" });

export interface HaltState {
  reason: string;
  engagedAt: string; // ISO-8601
  by: string;
}

const DEFAULT_HALT_FILE = join(homedir(), ".founderos", "HALT");

/** Resolve the halt flag-file path: HALT_FLAG_PATH env override, else $HOME/.founderos/HALT. */
export function haltFilePath(): string {
  const override = process.env["HALT_FLAG_PATH"];
  return override && override.trim().length > 0 ? override : DEFAULT_HALT_FILE;
}

/**
 * Engage the global halt. Writes the flag file (presence = halted).
 * Idempotent — re-engaging overwrites the metadata.
 */
export async function engageHalt(reason: string, by = "founder"): Promise<HaltState> {
  const state: HaltState = {
    reason: reason.trim() || "no reason given",
    engagedAt: new Date().toISOString(),
    by: by.trim() || "founder",
  };
  const file = haltFilePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), "utf8");
  log.warn({ ...state, file }, "GLOBAL HALT engaged — new turns will be refused");
  return state;
}

/** Release the global halt. Deletes the flag file. Idempotent (no error if absent). */
export async function releaseHalt(): Promise<void> {
  const file = haltFilePath();
  await rm(file, { force: true });
  log.warn({ file }, "Global halt released — turns will process normally");
}

/**
 * Read the current halt state. Returns null when NOT halted.
 * Fail-safe: a present-but-corrupt flag still reports halted (presence wins).
 * A non-ENOENT read error is logged and treated as not-halted (don't brick on
 * a transient FS error).
 */
export async function readHalt(): Promise<HaltState | null> {
  const file = haltFilePath();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.error({ file, err: (err as Error).message }, "Halt flag read error — treating as NOT halted");
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HaltState>;
    return {
      reason:
        typeof parsed.reason === "string" && parsed.reason.length > 0
          ? parsed.reason
          : "halt engaged (no reason recorded)",
      engagedAt: typeof parsed.engagedAt === "string" ? parsed.engagedAt : "unknown",
      by: typeof parsed.by === "string" ? parsed.by : "unknown",
    };
  } catch {
    // Corrupt flag file — presence still means halted (fail-safe, never fail-open).
    log.warn({ file }, "Halt flag present but unparseable — treating as halted (fail-safe)");
    return { reason: "halt engaged (flag file unreadable)", engagedAt: "unknown", by: "unknown" };
  }
}

/**
 * Pure: the Telegram (HTML) notice shown when a turn is refused due to global halt.
 * Deterministic for a given state — unit-tested.
 */
export function formatHaltNotice(state: HaltState): string {
  const reason = state.reason.trim().length > 0 ? state.reason : "no reason given";
  return (
    `🛑 <b>FounderOS is halted.</b>\n` +
    `Reason: <i>${escapeHtml(reason)}</i>\n` +
    `Engaged: ${escapeHtml(state.engagedAt)} (by ${escapeHtml(state.by)})\n\n` +
    `No new tasks will run until this is lifted. Send <code>/resume</code> to re-enable FounderOS.`
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
