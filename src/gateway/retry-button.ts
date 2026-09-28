/**
 * FounderOS — the 🔁 Retry button's payload
 * =========================================
 * `retry:<first 8 chars of the failed turn id>[:<profile id>]`.
 *
 * The button names the turn, not the text: the words to re-run are read back
 * from the thread's checkpoint on tap (retry-callback.ts), so a button stays
 * correct across a restart and goes stale the moment a newer turn runs.
 *
 * The profile rides along because it is the one input a turn has that is NOT
 * in the checkpoint: /draft and /wife_draft pass it in `configurable`
 * (kernel-run.ts). A retry without it would draft for the default candidate.
 *
 * Pure: no I/O, no grammy context. Shared by the failure card (kernel-run.ts)
 * and the thrown-error reply (error-reply.ts).
 */

export const RETRY_CALLBACK_PREFIX = "retry:";

/** Same length as the HITL approval card's nonce (kernel-run.ts). */
export const RETRY_NONCE_CHARS = 8;

/** Telegram rejects the whole keyboard when one callback_data exceeds 64 bytes. */
export const CALLBACK_DATA_MAX_BYTES = 64;

export const RETRY_BUTTON_LABEL = "🔁 Retry";

export interface RetryTarget {
  readonly nonce: string;
  readonly profileId?: string;
}

/**
 * The callback payload, or null when it cannot fit in 64 bytes.
 *
 * Null rather than truncated: dropping the profile to make room would produce a
 * button that retries as the wrong candidate, which is worse than no button.
 */
export function retryCallbackData(turnId: string, profileId?: string): string | null {
  const data = `${RETRY_CALLBACK_PREFIX}${turnId.slice(0, RETRY_NONCE_CHARS)}${profileId ? `:${profileId}` : ""}`;
  return Buffer.byteLength(data, "utf8") <= CALLBACK_DATA_MAX_BYTES ? data : null;
}

/** An inline keyboard with the one button, or undefined when the payload cannot fit. */
export function retryKeyboard(
  turnId: string,
  profileId?: string,
): { inline_keyboard: { text: string; callback_data: string }[][] } | undefined {
  const data = retryCallbackData(turnId, profileId);
  return data ? { inline_keyboard: [[{ text: RETRY_BUTTON_LABEL, callback_data: data }]] } : undefined;
}

/** Parse a tapped payload. Null for anything that is not a well-formed retry. */
export function parseRetryCallback(data: string): RetryTarget | null {
  if (!data.startsWith(RETRY_CALLBACK_PREFIX)) return null;
  const [nonce, profileId, ...rest] = data.slice(RETRY_CALLBACK_PREFIX.length).split(":");
  if (!nonce || nonce.length !== RETRY_NONCE_CHARS || rest.length > 0) return null;
  return profileId ? { nonce, profileId } : { nonce };
}
