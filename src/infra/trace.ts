/**
 * FounderOS — Turn Trace
 * =======================
 * One correlation id (turnId) per inbound Telegram turn, plus an ordered list of
 * the seams that turn crosses. Every event goes to structured logs (grep the
 * turnId = the whole turn) and, in tests, to an injectable sink (the oracle for
 * the Seam test tier). Emission is fail-safe: a trace error can NEVER break a turn.
 */
import { randomUUID, createHash } from "node:crypto";
import { logger } from "./logger.js";
import { scrubObject } from "./telemetry.js";

export type Seam =
  | "turn.in"
  | "route.decided"
  | "tool.call"
  | "tool.result"
  | "tool.error"
  | "llm.call"
  | "hitl.interrupt"
  | "hitl.resume"
  | "halt.blocked"
  | "wedge.recovered"
  | "checkpoint.trim"
  | "turn.out"
  | "turn.error";

export interface TraceEvent {
  turnId: string;
  seam: Seam;
  ms: number; // elapsed since turn start
  data?: Record<string, unknown>;
}

export interface TurnTrace {
  turnId: string;
  chatId: string;
  kind: "message" | "resume";
  promptHash: string;
  events: readonly TraceEvent[];
  event(seam: Seam, data?: Record<string, unknown>): void;
}

// Test sink — lets the Seam tier capture emitted events. Null in production.
export type TraceSink = (event: TraceEvent) => void;
// NOTE: module-level — safe because vitest isolates each test file in its own worker process; setTraceSink is never called in production.
let _sink: TraceSink | null = null;
export function setTraceSink(sink: TraceSink | null): void {
  _sink = sink;
}

const log = logger.child({ module: "trace" });

export function startTurn(opts: {
  chatId: string | number;
  kind: "message" | "resume";
  promptHash: string;
}): TurnTrace {
  const turnId = randomUUID();
  const t0 = Date.now();
  const chatId = String(opts.chatId);
  const events: TraceEvent[] = [];

  return {
    turnId,
    chatId,
    kind: opts.kind,
    promptHash: opts.promptHash,
    events,
    event(seam, data) {
      try {
        const safe = data ? (scrubObject(data) as Record<string, unknown>) : undefined;
        const ev: TraceEvent = { turnId, seam, ms: Date.now() - t0, data: safe };
        events.push(ev);
        log.info({ turnId, seam, ms: ev.ms, chatId, kind: opts.kind, data: safe }, `trace ${seam}`);
        _sink?.(ev);
      } catch {
        /* a trace failure must never break a turn (rule #19.5 fail-safe) */
      }
    },
  };
}

/** 12-char sha256 of the active prompt — stamped into traces to catch prompt regressions. */
export function activePromptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}
