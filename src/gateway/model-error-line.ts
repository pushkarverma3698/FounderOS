/**
 * FounderOS — one-line model errors (P2-6, audit F21).
 * ====================================================
 * On 2026-09-29 three turns in a row answered with a Gemini 400 "exclusiveMinimum"
 * stack, printed twice per message. The founder cannot act on a field name; he can
 * act on "the model refused that request, retry?". The raw error stays in the logs,
 * the trace and the failure card's expandable details; this is only what is SHOWN.
 *
 * Pure: error text in, one line out, or null when the text is not a model-API
 * rejection (so the caller keeps its own wording). Rate limits and outages are NOT
 * handled here: `isModelFallbackError` already gives them their own reply and auto-retry.
 */

/** A provider's 400-class rejection of the request itself. */
const REJECTION_PATTERN =
  /\[\s*400\b|INVALID_ARGUMENT|invalid_request_error|GenerateContentRequest|\b400\b[^\n]{0,40}Bad Request/i;

/** Wording providers use when the rejected part is a tool or response schema. */
const SCHEMA_PATTERN =
  /exclusiveM(?:in|ax)imum|Unknown name|Invalid schema|function_declarations|response_schema|additionalProperties|\.parameters\b|\btools\[\d+\]/i;

const SCHEMA_LINE = "The model refused that request (schema). Retry?";
const REQUEST_LINE = "The model refused that request (bad request). Retry?";

/** The one-line founder text for a model-API rejection, or null when `message` is something else. */
export function modelErrorLine(message: string): string | null {
  if (!REJECTION_PATTERN.test(message)) return null;
  return SCHEMA_PATTERN.test(message) ? SCHEMA_LINE : REQUEST_LINE;
}
