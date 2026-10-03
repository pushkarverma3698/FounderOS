/**
 * What `claude -p --output-format stream-json --verbose` prints, as the claude executor sees it.
 * ===========================================================================================
 * One home for the fixtures, so the lib test, the classifier test and the daemon test cannot disagree about the
 * shape of a stream. Provenance is per fixture:
 *
 *   captured  the event sequence and every text field were read off a real `claude` 2026-10-03 (VPS and laptop,
 *             0 tokens spent: both runs died before the model was called). Ids, timestamps and usage blocks are
 *             dropped; nothing the code reads is.
 *   shape     the event types and field names are the captured ones, the values are made up (a reset time that
 *             is in the future whenever the test runs, a tool call).
 *   synthetic written to exercise a branch; NOT seen from a real run. The success stream is the one that matters:
 *             no logged-in Claude was available, so the renderer's view of a working run is NOT VERIFIED live.
 */

const line = (e: Record<string, unknown>): string => JSON.stringify(e);
const join = (events: readonly Record<string, unknown>[]): string => events.map(line).join("\n");

const INIT = { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-5-5", tools: ["Bash", "Read", "Edit"] };

export const WEEKLY_LIMIT_TEXT = "You've hit your weekly limit · resets Oct 5, 6am (UTC)";

/**
 * [shape] The weekly limit. The CLI EXITS 0: only `rate_limit_info.status` and the result's `is_error` say it failed.
 * `resetsAt` is epoch seconds; the captured value was 1791180000 (2026-10-05 06:00 UTC), so tests pass a future one.
 */
export function weeklyLimitStream(resetsAt: number): string {
  return join([
    INIT,
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "seven_day" }, session_id: "s1" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: WEEKLY_LIMIT_TEXT }] }, error: "rate_limit", session_id: "s1" },
    { type: "result", subtype: "success", is_error: true, result: WEEKLY_LIMIT_TEXT, api_error_status: 429, terminal_reason: "api_error", session_id: "s1" },
  ]);
}

export const NOT_LOGGED_IN_TEXT = "Not logged in · Please run /login";

/** [captured] No credential at all. Exit 1. */
export const NOT_LOGGED_IN_STREAM = join([
  INIT,
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: NOT_LOGGED_IN_TEXT }] }, error: "authentication_failed", session_id: "s1" },
  { type: "result", subtype: "success", is_error: true, result: NOT_LOGGED_IN_TEXT, api_error_status: null, terminal_reason: "api_error", session_id: "s1" },
]);

export const BAD_TOKEN_TEXT = "Failed to authenticate. API Error: 401 OAuth access token is invalid.";

/** [captured] A token the API refused. Exit 1, after two 401 retries. */
export const BAD_TOKEN_STREAM = join([
  INIT,
  { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 592, error_status: 401, error: "authentication_failed", session_id: "s1" },
  { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 1060, error_status: 401, error: "authentication_failed", session_id: "s1" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: BAD_TOKEN_TEXT }] }, error: "authentication_failed", session_id: "s1" },
  { type: "result", subtype: "success", is_error: true, result: BAD_TOKEN_TEXT, api_error_status: 401, terminal_reason: "api_error", session_id: "s1" },
]);

/**
 * [synthetic] A working run: a Bash tool call that finishes, a Read that is still running when the stream ends,
 * narration, a rate-limit WARNING (status allowed_warning: not a failure) and a successful result.
 */
export const WORKING_STREAM = join([
  INIT,
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Reading the brief." }, { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "pnpm test --run" } }] }, session_id: "s1" },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] }, session_id: "s1" },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1791180000, rateLimitType: "seven_day" }, session_id: "s1" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "/opt/agy-workspace/founderos/src/a.ts" } }] }, session_id: "s1" },
  { type: "result", subtype: "success", is_error: false, result: "Opened the draft PR.", terminal_reason: "completed", session_id: "s1" },
]);
