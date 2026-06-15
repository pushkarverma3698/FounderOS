// scripts/log-review/sources.ts
import { readFileSync } from "node:fs";
import type { LogLine } from "./types.js";

/**
 * Coerce a pino `time` field to epoch ms. Prod logs emit ISO strings
 * (`"2026-06-14T23:03:10.481Z"`); tests/other emitters may use epoch ms
 * numbers. Unparseable values become 0 (ordering degrades gracefully).
 */
function toEpochMs(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

/**
 * Parse raw journalctl output (one pino JSON object per line) into LogLine[].
 * Non-JSON lines (systemd banners) are skipped. Pino emits trace event fields
 * (seam/turnId) at top level and the event `data` payload may be top-level too;
 * we expose both `data` (if present) and the original top-level via spread.
 */
export function parseLogLines(raw: string): LogLine[] {
  const out: LogLine[] = [];
  for (const ln of raw.split("\n")) {
    const s = ln.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      const line: LogLine = {
        level: typeof o["level"] === "number" ? (o["level"] as number) : 30,
        time: toEpochMs(o["time"]),
        raw: s,
        ...o,
      };
      // `...o` re-spreads the original ISO string back over `time`; restore the
      // numeric epoch so downstream ordering/grouping is numeric everywhere.
      line.time = toEpochMs(o["time"]);
      // If trace data was logged flat (no `data` wrapper), synthesize it so
      // timeline.ts can read turn.out metrics uniformly.
      if (line.seam && line.data === undefined) {
        line.data = o;
      }
      out.push(line);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Read + parse a journalctl dump file. */
export function loadLogFile(path: string): LogLine[] {
  return parseLogLines(readFileSync(path, "utf8"));
}
