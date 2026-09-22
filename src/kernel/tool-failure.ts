/**
 * FounderOS v3 kernel — tool-result failure classification.
 * =========================================================
 * The single place that decides whether a tool RESULT represents a failure.
 * Extracted from worker.ts 2026-09-23 (LOC budget) — worker.ts still re-exports
 * every symbol, so this is a move, not an API change.
 *
 * This decision is load-bearing: worker.ts writes `ok: !isFailureResult(result)`
 * into every ToolReceipt, and founderReceiptsBlock() turns those receipts into
 * the founder-facing line "✓ N actions completed and verified". A misclassification
 * here is a false claim in the founder's Telegram thread.
 */

/**
 * Deterministic failure convention for tool RESULTS (produced by code, never
 * parsed from model prose): a result is a failure iff it starts with "❌",
 * carries the structured [[TOOL_FAILURE …]] marker, or is a JSON envelope with
 * success/ok === false. hitlGate's rejection string starts with "❌" and
 * contains REJECTION_MARKER.
 */
export const TOOL_FAILURE_MARKER = "[[TOOL_FAILURE";
export const REJECTION_MARKER = "Rejected by founder";

/**
 * Fourth convention, added 2026-09-23: the failure PROSE that tool wrappers
 * actually return.
 *
 * The three structural conventions above are what wrappers are SUPPOSED to emit.
 * 58 call sites in src/agents/agent-tools/ emit none of them — they return a bare
 * template string (`Email send failed: …`, `Deploy failed: …`, `Command failed: …`,
 * `Claude Code failed: …`). Each one was classified ok:true, written into a
 * ToolReceipt as a success, and counted by founderReceiptsBlock().
 *
 * In production on 2026-09-22 that printed "✓ 1 action completed and verified"
 * underneath a reply reading "Mission incomplete … execution failed". The receipts
 * block is the mechanism that makes an action claim non-fabricable; counting a
 * refusal as a verified action makes it the fabricator.
 *
 * The detector is fixed rather than the 58 sites because this function is the one
 * choke point every tool result passes through (`ok = !isFailureResult(…)` below),
 * so the sites cannot regress past it and new wrappers are covered on arrival.
 *
 * ANCHORING IS THE WHOLE DESIGN. Every pattern is ^-anchored with a short subject
 * prefix whose character class excludes ':' and ','. A successful result whose
 * CONTENT discusses failure — a log read returning error lines, "4482 passed, 0
 * failed", an email quoting the word — must stay a success, because marking it
 * failed would hide real evidence behind a false receipt: the same defect pointing
 * the other way.
 */
const FAILURE_PROSE = [
  // "<Subject> failed: …" / "generate_image failed (upload): …" / "Crawl failed for …"
  /^[\w .()\/_-]{0,40}\bfailed\b\s*(?:\([^)]{0,40}\))?\s*(?::|for\b)/i,
  // Shouted status prefixes used by the guard paths.
  /^(?:ERROR|BLOCKED|DENIED|FAILED)\b\s*[:—-]/i,
  // Path/permission refusals surfaced without a subject.
  /^Access denied\b/i,
] as const;

export function isFailureResult(result: string): boolean {
  const head = result.trimStart();
  return (
    head.startsWith("❌") ||
    result.includes(TOOL_FAILURE_MARKER) ||
    /"(?:success|ok)"\s*:\s*false/.test(head.slice(0, 200)) ||
    FAILURE_PROSE.some((re) => re.test(head))
  );
}
