/**
 * Which coding CLI does a task go to: Antigravity (`agy`) or Claude Code (`claude`).
 *
 * The default lives in `~/.claude/coding-engine`, one word. The bot writes it (`/engine`) and the
 * VPS dispatcher reads the same file (`engine_default` in deploy/lib/engine.sh), so the two readers
 * must agree on every content. Both are strict: the first line with all whitespace removed is
 * exactly `claude`, or the answer is agy. A file that is missing, empty or holds any other word
 * means agy, because a typo must not send work to a CLI nobody picked.
 *
 * This lives in src/tools/ and not src/gateway/ because the dispatch tool needs it and nothing
 * outside the gateway may import the gateway (scripts/verify-architecture.ts, R1).
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Engine = "agy" | "claude";
export const ENGINES: readonly Engine[] = ["agy", "claude"];

/** The path engine.sh reads. Same file for the bot and the dispatcher: both run as the founderos user. */
export function codingEngineFile(): string {
  return join(homedir(), ".claude", "coding-engine");
}

/** What the founder reads on the approval card. "Google Antigravity" is what that card has always said. */
export function engineDisplay(engine: Engine): string {
  return engine === "claude" ? "Claude Code" : "Google Antigravity";
}

/** The GitHub label that records which CLI wrote or was assigned a task. onboard-repo.sh creates both. */
export function engineLabel(engine: Engine): string {
  return `engine:${engine}`;
}

const NAMES: Readonly<Record<string, Engine>> = {
  claude: "claude",
  "claude code": "claude",
  agy: "agy",
  antigravity: "agy",
  "google antigravity": "agy",
};

/** A word the founder or the planner typed → an engine, or undefined. Never guesses. */
export function parseEngine(value: unknown): Engine | undefined {
  if (typeof value !== "string") return undefined;
  return NAMES[value.trim().toLowerCase().replace(/\s+/g, " ")];
}

/**
 * The engine a message was addressed to by its command: `/claude …` or `/agy@Bot …`.
 * `/task …` and ordinary text name none. Only the whole command counts: `/claudex` does not.
 */
export function engineFromCommand(text: string): Engine | undefined {
  const match = /^\s*\/(claude|agy)(?:@\w+)?(?:\s|$)/i.exec(text);
  return match ? parseEngine(match[1]) : undefined;
}

/**
 * The engine an approval card was rendered for (`args.engine` in the stored HITL payload). The resume after the tap
 * passes it back as `configurable.engine`, because the gated tool body re-runs and would otherwise re-read the default
 * or lose a /claude or /agy the planner dropped, and file for a CLI the card never showed.
 */
export function engineFromApprovalCard(callbackData: string | null | undefined): Engine | undefined {
  if (!callbackData) return undefined;
  try {
    return parseEngine((JSON.parse(callbackData) as { args?: { engine?: unknown } }).args?.engine);
  } catch {
    // allow-failopen: a payload that is not JSON names no engine; the tool then refuses or uses its own argument.
    return undefined;
  }
}

/** The default engine. Same answer as `engine_default` in deploy/lib/engine.sh for every file content. */
export function readDefaultEngine(file: string = codingEngineFile()): Engine {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    // allow-failopen: a missing or unreadable file means "no default chosen", which is agy by design.
    return "agy";
  }
  const word = (content.split("\n")[0] ?? "").replace(/\s/g, "");
  return word === "claude" ? "claude" : "agy";
}

/**
 * Sets the default. Written to a temp file and renamed, so the dispatcher, which reads it from
 * another process every minute, never sees a half-written word. Throws on failure: /engine must say
 * so rather than tell the founder a switch happened that did not.
 */
export function writeDefaultEngine(engine: Engine, file: string = codingEngineFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${engine}\n`);
    chmodSync(tmp, 0o644);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
