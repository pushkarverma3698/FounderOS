---
paths:
  - "src/agents/**"
  - "src/gateway/kernel-boot.ts"
  - "scripts/apply-prod-env-overrides.sh"
  - "src/eval/**"
---

# Model policy

The model chain is deliberately not listed here. `scripts/apply-prod-env-overrides.sh` (`AGENT_MODEL` / `AGENT_FALLBACK_MODELS`) is the single source. Mirroring it into markdown is how prod once ran a dead OpenRouter fallback tail for weeks.

- `AGENT_MODEL` is direct paid Gemini and needs the `GOOGLE_GENERATIVE_AI_API_KEY` GitHub secret, or prod returns 401.
- `AGENT_FALLBACK_MODELS`: same-key paid Gemini first, free OpenRouter last. Founder directive: no paid OpenRouter fallback, ever.
- Temperature 0. `WORKER_AGENT_MODEL` splits the planner from the workers. Budget caps: `BUDGET_DAILY_USD`, `RUN_BUDGET_USD`.
- Provider errors classify by HTTP status class (`httpStatusOf` / `is503Error` / `isModelFallbackError` in `src/agents/model.ts`): 5xx/429/transport are retriable, 404 means model fallback, 401/403 fail loud.
- While iterating use `AGENT_MODEL=openrouter:google/gemini-2.5-flash-preview-05-20:free` (fallback `openrouter:deepseek/deepseek-r1:free`), never `google-genai:*`.
