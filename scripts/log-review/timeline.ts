// scripts/log-review/timeline.ts
import type { LogLine, Turn } from "./types.js";

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Group pino log lines by turnId into ordered Turn[]. Pure. */
export function buildTimeline(lines: LogLine[]): Turn[] {
  const byTurn = new Map<string, Turn>();

  for (const line of lines) {
    const id = line.turnId;
    if (!id) continue; // orphan lines never create a synthetic turn

    let turn = byTurn.get(id);
    if (!turn) {
      turn = {
        turnId: id,
        startMs: line.time,
        endMs: line.time,
        lines: [],
        toolErrors: 0,
        hadError: false,
      };
      byTurn.set(id, turn);
    }

    turn.lines.push(line);
    turn.startMs = Math.min(turn.startMs, line.time);
    turn.endMs = Math.max(turn.endMs, line.time);
    if (line.level >= 50) turn.hadError = true;
    if (typeof line["chatId"] === "string") turn.chatId = line["chatId"];

    if (line.seam === "turn.out" && line.data) {
      turn.inputTokens = num(line.data["inputTokens"]) ?? turn.inputTokens;
      turn.outputTokens = num(line.data["outputTokens"]) ?? turn.outputTokens;
      turn.usd = num(line.data["usd"]) ?? turn.usd;
      // Prod logs `ms` at the TOP LEVEL of the trace line, not inside `data`;
      // read data first (test/flat emitters), fall back to top-level (prod).
      turn.durationMs = num(line.data["ms"]) ?? num(line["ms"]) ?? turn.durationMs;
      const te = num(line.data["toolErrors"]);
      if (te !== undefined) turn.toolErrors = te;
    }
    const preview = line.data?.["replyPreview"];
    if (typeof preview === "string") turn.reply = preview;
  }

  return [...byTurn.values()].sort((a, b) => a.startMs - b.startMs);
}
