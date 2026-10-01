/**
 * FounderOS — goals: the days a halt swallowed
 * ============================================
 * While FounderOS is halted the 09:00 standup does not run. The founder is told once, at /resume, which
 * days were skipped ("standup skipped on 30 Sep, 1 Oct"). The record is a small JSON file beside the halt
 * flag (`~/.founderos/standup-skipped.json`, or next to `HALT_FLAG_PATH`): the halt itself is a flag FILE
 * (src/infra/halt.ts), so its companion lives and dies with it and needs no table.
 *
 * A file that cannot be read is treated as empty, loudly: a corrupt ledger must never make /resume fail.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { haltFilePath } from "../infra/halt.js";
import { childLogger } from "../infra/logger.js";
import { formatShortDate, isValidDateKey } from "./local-date.js";

const log = childLogger({ module: "goals-skipped" });

export interface SkipLedger {
  /** Remember that the standup for this local date did not run because FounderOS was halted. Idempotent. */
  record(dateKey: string): Promise<void>;
  /** The skipped days in date order, and forget them: they are reported once. */
  take(): Promise<string[]>;
}

export function skipLedgerPath(): string {
  return join(dirname(haltFilePath()), "standup-skipped.json");
}

async function readDates(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    log.error({ path, code: (err as NodeJS.ErrnoException).code }, "Could not read the skipped-standup ledger; treating it as empty");
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const dates = typeof parsed === "object" && parsed !== null ? (parsed as { dates?: unknown }).dates : undefined;
    if (!Array.isArray(dates)) return [];
    return [...new Set(dates.filter((d): d is string => typeof d === "string" && isValidDateKey(d)))].sort();
  } catch {
    log.error({ path }, "The skipped-standup ledger is not valid JSON; treating it as empty");
    return [];
  }
}

export function createFileSkipLedger(path: string = skipLedgerPath()): SkipLedger {
  return {
    async record(dateKey: string): Promise<void> {
      const dates = await readDates(path);
      if (dates.includes(dateKey)) return;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ dates: [...dates, dateKey].sort() }), "utf8");
    },
    async take(): Promise<string[]> {
      const dates = await readDates(path);
      await rm(path, { force: true });
      return dates;
    },
  };
}

/** "standup skipped on 30 Sep, 1 Oct", or null when nothing was skipped. */
export function formatSkippedLine(dates: readonly string[]): string | null {
  return dates.length === 0 ? null : `standup skipped on ${dates.map(formatShortDate).join(", ")}`;
}
