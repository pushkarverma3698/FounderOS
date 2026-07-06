/**
 * FounderOS — Structured Tool-Failure Envelope
 * =============================================
 * Deterministic, stage-tagged tool failures (rules #22, #24). Two problems this
 * solves, both observed in prod:
 *
 *   1. False negatives — a real tool error was returned as a plain string and the
 *      keyword heuristic (`isToolFailure`) missed it, so the founder got a cheery
 *      "✅ Done." that hid a failure.
 *   2. Misattributed errors — a DB/empty-store failure was labelled "Ollama
 *      unavailable" (2026-06-15 RAG outage), sending debugging down the wrong road.
 *
 * Every soft-failing tool returns `toolFailure(stage, message)`:
 *   - LEADS with a founder-readable "❌ <message>" line (surfaced verbatim), and
 *   - ENDS with a stable machine marker `[[TOOL_FAILURE stage=<stage>]]` that the
 *     gateway detects with 100% precision — no fuzzy keyword guessing.
 *
 * `stage` names the REAL failing component so the error points at its own fix.
 */

/** The component that actually failed — never collapse distinct failures. */
export type ToolFailureStage =
  | "db" // Postgres / pgvector — e.g. fix with `pnpm brain:sync`
  | "embedding" // Ollama / embedding service
  | "network" // transient connectivity / timeout
  | "auth" // missing or invalid API key / credential
  | "validation" // bad input that failed a boundary check
  | "external_api" // Composio / Gmail / GitHub / LinkedIn upstream
  | "unknown";

/** Stable marker — must never change once shipped (the gateway greps for it). */
export const TOOL_FAILURE_MARKER = "[[TOOL_FAILURE";

const MARKER_RE = /\[\[TOOL_FAILURE stage=([a-z_]+)\]\]/;

/**
 * M4 fix — stable marker for a DELIBERATE, successful soft-decline: the tool
 * did exactly what it should (didn't send because the founder's own policy
 * said not to), but the message happens to contain a keyword
 * (`isToolFailure`'s legacy fallback heuristic in office-run.ts scans for
 * "blocked"/"denied"/"limit"/etc.) that would otherwise misfire a "⚠️ Tool
 * issue" banner onto a correct, expected outcome. Distinct from
 * TOOL_FAILURE_MARKER: this says "not a failure, don't flag me — regardless
 * of what keywords appear in this text", not "this failed, here's the stage".
 */
export const TOOL_NOTICE_MARKER = "[[TOOL_NOTICE]]";

/**
 * Format a soft tool failure. The body is human-readable (surfaced to the
 * founder); the trailing marker is machine-readable (detected by the gateway).
 */
export function toolFailure(stage: ToolFailureStage, message: string): string {
  return `❌ ${message.trim()} ${TOOL_FAILURE_MARKER} stage=${stage}]]`;
}

/**
 * Wrap a message that is a deliberate, successful soft-decline (suppressed
 * recipient, daily send limit, duplicate-outreach guard, etc.) — never a
 * failure, no matter what keywords the message contains.
 */
export function toolNotice(message: string): string {
  return `${message.trim()} ${TOOL_NOTICE_MARKER}`;
}

/** Deterministic: true iff the content carries a failure envelope marker. */
export function isStructuredToolFailure(content: string): boolean {
  return MARKER_RE.test(content);
}

/** True iff the content is explicitly marked as a non-failure notice (M4). */
export function isToolNotice(content: string): boolean {
  return content.includes(TOOL_NOTICE_MARKER);
}

/** The named failing component, or null when the content is not an envelope. */
export function getToolFailureStage(content: string): ToolFailureStage | null {
  const m = MARKER_RE.exec(content);
  return m ? (m[1] as ToolFailureStage) : null;
}

/**
 * Wrap a tool body so an unexpected throw becomes a stage-tagged envelope
 * instead of a raw crash or a swallowed error. `what` describes the operation
 * (e.g. "read founder_context") so the founder-facing message is specific.
 */
export async function withToolErrorBoundary<T extends string>(
  stage: ToolFailureStage,
  what: string,
  fn: () => Promise<T>,
): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return toolFailure(stage, `${what} failed: ${detail}`);
  }
}
