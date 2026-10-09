/**
 * FounderOS — OpenRouter key spend limit, as a typed failure (issue #1052)
 * ======================================================================
 * Prod 2026-10-09: the OpenRouter key reached its $10 total limit. OpenRouter
 * answers every call with `403 Key limit exceeded (total limit)`, and the founder
 * got that raw text plus a key-hash URL on every turn. Nothing retries its way
 * out of a spend limit, and every fallback model sits on the same key, so this
 * error must stop the turn at once and say what to do.
 */

/** OpenRouter's 403 for a key that has spent its limit. A plain 403 (bad key, region block) does not match. */
export function isKeyLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: unknown }).status;
  return (status === 403 || /^403\b/.test(err.message)) && /key limit exceeded/i.test(err.message);
}

/**
 * Thrown in place of the provider's 403. The kernel treats it as terminal by
 * NAME (src/kernel/errors.ts), so it reaches the gateway reply untouched.
 */
export class ProviderKeyLimitError extends Error {
  override readonly name = "ProviderKeyLimitError";
  constructor(cause: unknown) {
    super(`OpenRouter key limit reached: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";

const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The founder's line: "OpenRouter key limit reached ($10.00 of $10.00); raise it at …".
 * The amounts come from OpenRouter's /key endpoint, which still answers on a
 * spent key. If that lookup fails, the line goes out without the amounts.
 */
export async function keyLimitLine(timeoutMs = 3_000): Promise<string> {
  let amounts = "";
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (apiKey) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = ((await res.json()) as { data?: { limit?: unknown; limit_remaining?: unknown } }).data;
      if (typeof data?.limit === "number" && typeof data.limit_remaining === "number") {
        amounts = ` (${usd(Math.max(0, data.limit - data.limit_remaining))} of ${usd(data.limit)})`;
      }
    } catch {
      // allow-failopen: the amounts are a detail; the line without them still says what to do
    }
  }
  return `OpenRouter key limit reached${amounts}; raise it at ${OPENROUTER_KEYS_URL}`;
}
