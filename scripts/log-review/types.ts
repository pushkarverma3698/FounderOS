// scripts/log-review/types.ts
// Shared shapes for the log-review funnel. No I/O, no logic.

export type Severity = "high" | "medium" | "low";

export type SignalType =
  | "error" // level:50, 503/400/409, crash
  | "wedge" // recursion / budget abort, wedged thread
  | "send_without_audit" // external send with no action_log row
  | "double_exec" // same idempotency key executed twice
  | "silent_fail" // "Done." reply with no supporting row
  | "reset_churn" // repeated /reset or repeated identical user message
  | "latency_cost" // turn.out ms or usd spike
  | "empty_store" // RAG / knowledge store has zero rows
  | "dead_tool_key" // integration key invalid / tool outage
  | "hallucination_candidate"; // borderline — Claude judges in Stage 3

/** One parsed pino JSON log line from prod journalctl. */
export interface LogLine {
  level: number; // pino numeric level (50=error, 40=warn, 30=info)
  time: number; // epoch ms
  seam?: string; // trace seam, e.g. "turn.out"
  turnId?: string;
  msg?: string;
  module?: string;
  data?: Record<string, unknown>;
  raw: string; // original line, for evidence
  [k: string]: unknown;
}

/** All log lines belonging to one turn, plus derived facts. */
export interface Turn {
  turnId: string;
  chatId?: string;
  startMs: number;
  endMs: number;
  lines: LogLine[];
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  durationMs?: number; // from turn.out ms
  toolErrors: number;
  hadError: boolean; // any level>=50 line
  reply?: string; // replyPreview if present
}

/** A deterministic finding the funnel can prove. */
export interface Anomaly {
  type: SignalType;
  severity: Severity;
  turnId?: string;
  summary: string; // one line, human-readable
  evidence: string[]; // raw log lines / counts backing the claim
}

/** A DB-state finding (rule #22 — verify state, not schema). */
export interface StateFinding {
  type: SignalType;
  severity: Severity;
  summary: string;
  evidence: string[];
}

/** The bounded artifact Claude reads in Stage 3. */
export interface Digest {
  generatedAt: string; // ISO
  windowDays: number;
  contentHash: string; // hash of the issue set → stable branch name
  counts: {
    turns: number;
    errors: number;
    warns: number;
    healthyTurns: number;
  };
  hardAnomalies: Anomaly[];
  stateFindings: StateFinding[];
  borderlineTurns: Turn[]; // capped candidate set for Claude to judge
  truncated: boolean; // true if candidates exceeded the cap
}
