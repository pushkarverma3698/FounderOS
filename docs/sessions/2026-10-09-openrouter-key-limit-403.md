# 2026-10-09 — OpenRouter key-limit 403 (issue #1052)

**Shipped:** #1054 (to beta), then #1056 (promotion). Prod is on 868e2ea8; the deploy succeeded and the service restarted at 06:43Z.

## Findings
- The 35 s "Request timed out." turns at 21:30Z on 10-08 were not caused by the 403. The VPS lost outbound network from 21:30Z to 03:05Z: board sweeps failed 3186/3186. The undici connect timeout was retried 3 times with backoff, which adds up to about 35 s. This conclusion comes from timing correlation; the cause of the outage was not found.
- The 403 was already instant and never started a fallback, but it reached the founder raw, with the key-hash URL.
- Spend: on 10-08, Claude Sonnet 5.5 calls cost about $3.9 in one day (engineering worker: 48 calls, $2.51). Prod is now on Gemini 3.6 Flash and Ling 3.0 Flash. Source: `agents.ai_call_costs`.

## Change
- A key-limit 403 now throws `ProviderKeyLimitError`, which the kernel treats as terminal. No fallback runs, since every model uses the same key.
- The reply is `🔑 OpenRouter key limit reached ($X of $Y); raise it at https://openrouter.ai/settings/keys`. It has no Retry button.

## Verified
- Fail-first unit tests, then `pnpm gate` green (9520 tests); CI green on both PRs.
- Telegram probe after the deploy: "What reminders do I have?" got a correct reply in 12 s.

## NOT VERIFIED
- The live 🔑 reply. Credits were added before the deploy, so the key-limit path can't be triggered on prod.

## Follow-ups
- LangChain's `TimeoutError` is not treated as a transport error, so the fallback chain never starts on a timeout.
- Fallback models are not retry-wrapped.
- The key had no OpenRouter spend limit as of 06:4xZ (`limit: null`).
