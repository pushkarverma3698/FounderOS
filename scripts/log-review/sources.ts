// scripts/log-review/sources.ts
import { readFileSync } from "node:fs";
import type { LogLine } from "./types.js";

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
        time: typeof o["time"] === "number" ? (o["time"] as number) : 0,
        raw: s,
        ...o,
      };
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
