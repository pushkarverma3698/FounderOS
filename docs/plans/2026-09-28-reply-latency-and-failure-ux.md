# Plan: reply latency + failure UX (items 1 and 2 of the 2026-09-28 audit)

- **Branch:** `claude/fix-gemini-thinking-and-failure-ux` (already exists on origin, base `beta`). PR → `beta`.
- **Evidence:** `docs/plans/2026-09-28-perf-ux-rag-audit.md`. Read it first.
- **Depth: Full.** It changes third-party API call parameters (Gemini), the budget/cost ledger,
  and adds a retry path that re-runs turns able to reach HITL-gated sends.
- **Founder approval:** items 1 and 2 approved in chat on 2026-09-28, plus one live measurement
  (done; results in the audit §1).

## Outcome the founder feels

He types "list my 3 most recent emails" and the answer lands in about 5 s, not 12 s. When a task
fails, the message says what failed in plain words and has a 🔁 Retry button. When he asks for
fresh jobs in free text, every role shows when it was posted and when it was found. The ☰ menu
has 17 entries instead of 34.

## Correction to the approved scope (rule #28)

Item 1 as first proposed also said "stream the reply" and "skip the rewrite step on one-step
tasks". The measurement changed both:

- **Skip the synthesizer: dropped.** With thinking off it costs about 1.5 s, and it is the only
  LLM call that sees nothing but validated results. It carries the "absence is reported as
  absence" guard written after the 2026-09-16 incident. Skipping it trades a guard for about 1.5 s.
- **Streaming: deferred and gated on data.** After this ships, run `scripts/latency-report.ts`
  (commit 1) on 7 days of prod traces. Build streaming only if p50 is still above 8 s.

## Commits (one per logical change, in this order)

### 1. `scripts/latency-report.ts`: make the before/after measurable (tooling)
Pure parser plus a thin CLI. Input: journal JSON lines on stdin (`"module":"trace"` lines). Output:
one row per turn (time, total ms, llm-call count, tool-call count, first 60 chars of input) and
p50/p90/max over turns that have `turn.in` plus `turn.out` or `turn.error`. Unit-test the parser
on a fixture of about 10 lines, taken from the shapes quoted in the audit. Usage line in the
header:
`ssh founderos-vps 'sudo -n journalctl -u founderos --since "7 days ago" -o cat' | node --import tsx/esm scripts/latency-report.ts`.
Baseline to beat: **p50 18.6 s, p90 157 s** (91 turns, 30 days to 2026-09-28).

### 2. Gemini thinking: `thinkingConfig: { thinkingLevel: "LOW" }` on every `google-genai` model
- Where: the `parsed.provider === "google-genai"` branch of the model factory in
  `src/agents/model.ts`, which builds `new ChatGoogleGenerativeAI({ apiKey, model, temperature, maxRetries: 2 })`.
  `@langchain/google-genai` 2.1.31 accepts `thinkingConfig` in the constructor and forwards it into
  `generationConfig` (`dist/chat_models.js`, around line 447). Its type allows
  `"LOW" | "MEDIUM" | "HIGH"`. It does not allow `"MINIMAL"`: use `"LOW"`.
- One env override, `GEMINI_THINKING_LEVEL` = `LOW` (default) | `MEDIUM` | `HIGH` | `DEFAULT`
  (`DEFAULT` omits `thinkingConfig`, restoring today's behaviour). Parse it in `src/core/config.ts`
  with the existing env-validation pattern. It is the rollback lever if plan quality drops.
- Do not touch the `google-vertexai` branch (not used in prod; `ChatVertexAI` takes a different
  config) or any OpenRouter/OpenAI branch.
- Covers the planner, worker, synthesizer and judge, which all use `google-genai` in prod.
  **Read `scripts/apply-prod-env-overrides.sh` to confirm this; do not trust this line.**
- Measured already (audit §1): `LOW` returns HTTP 200 on gemini-3.6-flash, gemini-3.1-flash-lite
  and gemini-3-flash-preview, the three Gemini slugs in the prod chain. Latency drops about 3 s
  per call, and plan shape matched on a multi-step request (6.5 s → 2.7 s).
- RED first: a test that builds a `google-genai` model and asserts
  `(model as ChatGoogleGenerativeAI).thinkingConfig` deep-equals `{ thinkingLevel: "LOW" }`. Also
  assert it is absent for `DEFAULT`, and that an OpenRouter model is unaffected. **Assert the
  field, not the class.** The 2026-09-05 OmniRouter review found a guard test that pinned
  `ChatOpenAI` and so missed an endpoint change.

### 3. Cost ledger counts thought tokens
- Today `ai_call_costs.tokens_out` receives `usage_metadata.output_tokens`, which LangChain sets
  to `candidatesTokenCount` (excludes thoughts). `total_tokens` is `totalTokenCount` (includes
  them).
- Find where the LLM result becomes an `AccruedCall` (`inputTokens` / `outputTokens`); it is in or
  near `src/infra/budget.ts`. Make output = `max(output_tokens, total_tokens - input_tokens)` when
  `total_tokens` is present. Price stays the output price: Gemini bills thoughts as output.
- RED first: a fake LLM result with `{ input_tokens: 100, output_tokens: 50, total_tokens: 400 }`
  must record 300 output tokens. A result without `total_tokens` must record 50.
- Consumers to re-check (stage 5, question 4): the run budget cap (`enforceRunBudget`), the daily
  cap (`assertDailyBudgetAllowsRun` → `getTodayCostUsd`), `/budget`, and `pnpm proof:costs`. The
  ledger becomes truthful, so recorded spend rises. With `LOW` thoughts are about 0, so expect
  little change.

### 4. Free-text job answers carry posted and found dates
- `queryJobState` in `src/db/job-queries.ts`: its curated (non-`fullDetails`) select returns
  `created_at` but not `posted_at`. Add `posted_at` to the curated select.
- `job_state` tool description (`src/tools/job-state.ts`): the `since` filter reads `created_at`.
  Say so in the description ("found since"), because it is not a posting-date filter.
- Jobhunt worker prompt (`src/agents/prompts/jobhunt.ts`): whenever roles are listed, each one
  shows `posted <date>` (or `posting date unknown` when null) and `found <date>`. Never call a
  role "today's" from `created_at` alone. Reuse the vocabulary of `ageLine` in
  `src/tools/jobhunt/brief-row.ts` so commands and free text say the same thing.
- RED first: a test that the curated rows include `posted_at`. Check existing tests for
  `queryJobState` to see how they stub the DB.

### 5. Failure replies in plain words, with a Retry button
Three founder-visible pieces, all in `src/gateway/` (the kernel stays untouched; its
`formatFailureReply` text also feeds planner history and tests):

- **Renderer** (new pure module, e.g. `src/gateway/failure-card.ts`): input `FailureReport` + ok
  results + the failed step's objective. Output HTML:
  `⚠️ I couldn't finish: <objective>` / `Why: <message>` / completed steps, if any / then
  `<blockquote expandable>` holding `stage · component · evidence`. The founder always sees the
  component (CLAUDE.md invariant), but collapsed. Pass objective and message through
  `redactInternalIdentifiers` / `redactInternalPaths` (`src/kernel/founder-text.ts`), the same
  scrubbing `kernel-progress.ts` applies.
- **Button:** `🔁 Retry`, callback data `retry:<first 8 chars of turnId>[:<profileId>]` (must stay
  ≤ 64 bytes). Attach it when (a) the turn completed with `state.failure` set and
  `failure.stage !== "hitl_rejected"` (in `runKernelText` in `kernel-run.ts`, after the stream,
  where the reply is sent today), or (b) a thrown error reached `replyForError` **and no
  auto-retry was queued** (`enqueueTurnAutoRetry` returned false). Never both a queued auto-retry
  and a button.
- **Handler** (new module, e.g. `src/gateway/retry-button.ts`; `telegram.ts` and `kernel-run.ts`
  are near the 400-LOC cap). Route `retry:` in the `callback_query:data` handler in `telegram.ts`
  **before** the approve/reject fall-through. On tap: `getState` for the thread; the failed turn is
  `state.values.turn`; if `turn.id` does not start with the nonce, answer "This retry is for an
  older message" and stop. Otherwise remove the button (`editMessageReplyMarkup`) and call
  `runKernelText(ctx, turn.raw_input, profileId)`.

Defect-hunt items for this commit; write the failing test before calling any of them fine:
- **Profile loss.** `/draft` / `/wife_draft` turns pass `profileId` in `configurable`, not in
  state. A retry without it would draft for the wrong candidate. Hence the profile in the callback
  data. Test: a retry of a Tashi-profile turn runs with `profile_id` = her profile.
- **Double tap.** The first retry starts a new turn, so `state.turn.id` changes and the second
  tap's nonce no longer matches. Test it. `withChatTurnLock` serializes but does not dedupe.
- **Re-sending on retry.** If the failed turn had already completed an approved send before
  failing, does the retry send again? Read how `src/infra/hitl.ts` and the send tools derive
  their idempotency key. If the key contains the turn id, a retry re-sends. Prove with a test,
  either way, before shipping.
- **Stale card after restart.** A button pressed after a deploy restart still resolves through
  the checkpointer (Postgres), so it must work, or fail with the same "older message" text. Never
  throw.

### 6. One command set in the ☰ menu
- Every job command already takes a profile word (`/jobs tashi`, `jobhunt-profile-arg.ts`). Drop
  the 17 `wife_*` rows from the `setMyCommands` payload (`src/gateway/command-menu.ts`,
  `telegramCommandPayload`). **Keep every `wife_*` handler registered**, as hidden aliases: he has
  typed them for months.
- Reword the kept descriptions to name the word, e.g. "Everything on file, freshest first —
  `/jobs tashi` for Tashi's". Update `/start` (`home-menu.ts`) and `/commands` to match.
- `src/gateway/commands.ts` (around line 107) cross-checks the menu against real `bot.command()`
  registrations. Read that check; add a `hidden` flag rather than deleting rows, so aliases stay
  registered and tested.
- RED first: the payload has 17 fewer rows; every hidden alias is still registered.

## Binding repo rules (from CLAUDE.md; CI enforces the first four)
- No `src` file over 400 lines. `kernel-run.ts` is 347 and `telegram.ts` 296 today, so put new
  logic in new modules.
- Import direction: contracts ← kernel ← gateway. The kernel never imports gateway.
- Every fail-open `catch` needs `// allow-failopen: <reason>`.
- Tombstoned modules must not be re-created. Run `pnpm verify:arch`.
- Zero paid calls in tests. `pnpm test` must stay $0.
- Branch name is already valid. Do not rename it.

## Verification the cloud session must show (paste the real output)
1. RED → GREEN per commit (test name + the failing assertion before the fix).
2. CI's exact commands: `pnpm ci:quality` and `pnpm test` (N/N pass, 0 skipped, counts shown),
   then `pnpm gate`. Use `cmd > /tmp/x-$$.log 2>&1; echo $?`, never `| tail`, which masks the
   exit code.
3. Mutation probe: for each new guard (thinking-level parse, `total_tokens` branch, nonce check,
   `hitl_rejected` exclusion, auto-retry exclusion, hidden-alias registration), delete or invert it
   and show a test goes red.
4. Draft PR to `beta` following `.github/pull_request_template.md`, with the three sections:
   **What changed**, **How it was verified**, **NOT VERIFIED**.

## NOT VERIFIED from a cloud session (list these in the PR)
- Live Telegram path (no VPS or MTProto access from cloud). After merge, the founder sends "Hi",
  "list my 3 most recent emails" and one job question; then run `scripts/latency-report.ts` over
  the window and paste p50/p90 against the 18.6 s / 157 s baseline.
- Live plan quality at scale: `pnpm eval` is paid and needs the prod key. One run from the local
  machine after the PR is green, comparing routing against the last scoreboard.
- Brain rows (the turicks-brain MCP is unreachable from cloud). Save afterwards from a local session.
