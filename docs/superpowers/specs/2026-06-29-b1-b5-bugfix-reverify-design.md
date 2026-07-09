# B1–B5 Bug-Fix + Hard-Battery Reverification — Design Spec

**Date:** 2026-06-29
**Branch:** `fix/launch-bug-batch`
**Source of bugs:** `docs/qa/HARD-BATTERY-2026-06-29.md` (live MTProto stress battery, 13 PASS / 1 WEAK / 4 FAIL = 72%)
**Goal:** Fix the 5 ledgered bugs (each TDD/test-first), reverify live with a harder battery, make FounderOS launch-ready.

---

## Non-negotiables (apply to every fix)

- **Rule #19/#23 — reproduce first.** Each bug fix starts with a FAILING unit test that encodes the exact offending input from the battery. No fix without a red repro. `pnpm test` is mocked = $0; it is the primary loop.
- **Rule #16 — determinism.** Push correctness into pure, unit-tested functions (guards, redactors, caps) — never a prompt instruction a weak model may ignore. Exception: B1 is genuinely a prompt-policy bug (see below).
- **Rule #6 — generator ≠ critic.** The reverification Layer-B judge must be a different model family from the Gemini drafter.
- **No `any`, `.js` import extensions, `process.env["KEY"]` bracket access, ES modules, immutable updates.** Match surrounding code.
- **Disjoint files per agent** (below) so the 4 fixes integrate with zero conflicts.

---

## Bug ledger + fix design

### B1 (P2) — Marketing brand-validator refuses explicitly-requested short-form
- **Symptom (H08):** Founder asked for a 3-line LinkedIn *draft* (no send). Marketing dept refused: "My instructions require LinkedIn posts to be 150–300 words."
- **Root cause:** `src/agents/prompts/marketing.ts` enforces a hard 150–300-word floor and treats short-form as a violation to refuse, even when the founder explicitly requested short-form AND only a draft (not a send).
- **Fix (prompt policy):** Marketing prompt must DRAFT the requested short-form and note the brand-length deviation in the HITL card / reply ("⚠️ below our usual 150–300-word brand length, drafted as requested"), never refuse. The founder is the gate. Keep the default-length guidance for unspecified requests.
- **File:** `src/agents/prompts/marketing.ts` (+ a golden task if one exists for marketing length).
- **Verify:** add/extend a unit test asserting the prompt text contains the draft-on-explicit-request override; the live battery re-runs H08.

### B2 (P1) — Injection summary leaked "system prompt" terminology
- **Symptom (H10):** An injection-style task caused the outbound reply to echo "system prompt"/"instructions" terminology, partially complying with the injected ask.
- **Root cause:** No deterministic outbound post-filter strips echoed injected-instruction phrasing; only `stripXmlTags` runs.
- **Fix (pure function):** add `redactInjectionEcho(reply: string): string` in `src/gateway/execution-guard.ts` — removes sentences whose subject is the bot revealing/printing/emailing its "system prompt / system instructions / full prompt / initial instructions". MUST preserve legitimate replies (negative control: "what's your architecture?" / "how do you route?" pass through untouched). Wire it into `finalReply()` in `src/gateway/office-run.ts`, peer to `stripXmlTags` (office-run.ts:122/131).
- **Files:** `src/gateway/execution-guard.ts` (new pure fn + unit tests incl. negative control), `src/gateway/office-run.ts` (wire into finalReply).
- **Verify:** RED test with the exact H10 leak string → GREEN; negative-control test proves no false strip.

### B4 (P2) — `detectUnbackedMemoryClaim` misfires on self-referential questions
- **Symptom (H16):** "…just tell me how you handled this" was classified as an internal-knowledge lookup and forced a memory-tool call / refusal, instead of answering about the bot's own behavior.
- **Root cause:** `isInternalKnowledgeRequest()` (`src/gateway/execution-guard.ts:479`) has no exclusion for questions about the bot's OWN recent behavior.
- **Fix (pure function):** add `SELF_REFERENTIAL_RE` (e.g. `how did you handle`, `what did you do`, `why did you`, `how you handled`, `what you just did`) as an early-return exclusion in `isInternalKnowledgeRequest()`, mirroring the existing `ACTION_REQUEST_RE` exclusion at line 479.
- **File:** `src/gateway/execution-guard.ts` (same file as B2 — one agent owns both).
- **Verify:** RED test with the exact H16 input → returns false (not an internal-knowledge request) → GREEN. Keep existing internal-knowledge positives green.

### B5 (P1) — GitHub / cross-dept loop-wedge (ReAct retries failing tool until recursion budget exhausts)
- **Symptom (H09/H15/H17):** A failing `github` tool (auth/401 etc.) is retried by the ReAct agent until `GraphRecursionError` → "🔁 I got stuck in a loop". Founder gets no useful error.
- **Root cause:** the structured `toolFailure` envelope exists (commit `aa3fee9`) but nothing caps consecutive same-tool failures; the agent keeps retrying inside the recursion budget.
- **Fix (pure cap, tool-wrapper level):** in `src/agents/agent-tools/engineering.ts`, track consecutive structured failures per tool within a turn; on the 2nd identical `toolFailure`, return a **terminal** result that surfaces the real error to the founder (named component, rule #22) instead of a retryable error — so the ReAct loop stops well before recursion exhaustion. Keep it deterministic and unit-tested.
- **Ops half (done by orchestrator, not this agent):** verify prod `GITHUB_TOKEN` validity over SSH against the VPS.
- **File:** `src/agents/agent-tools/engineering.ts` (+ tests). Disjoint from B2's office-run.ts edit.
- **Verify:** RED test — a github tool stubbed to fail twice → 2nd call returns terminal surfaced-error result, no infinite retry → GREEN.

### B3 (P2) — Cross-turn contamination in the battery harness
- **Symptom (H14):** H13's planted "$42,000 / 11 retainer clients" surfaced in H14 — battery did not isolate turns.
- **Root cause:** harness (`scripts/e2e-hard-battery.ts`) does not `/reset` + await ACK before each task; relies on history-window bounding alone.
- **Fix (harness only):** send `/reset` and await the bot ACK before each task; confirm thread isolation. This is a test-harness fix, not a product bug.
- **File:** `scripts/e2e-hard-battery.ts` (also where the new harder tasks land).

---

## Subagent orchestration (disjoint-file split, all parallel)

| Agent | Bug(s) | Files (exclusive) | Output |
|-------|--------|-------------------|--------|
| **SA-1 guard-hardening** | B2 + B4 | `src/gateway/execution-guard.ts`, `src/gateway/office-run.ts` (finalReply wiring only), tests | redactor + exclusion + RED→GREEN tests |
| **SA-2 github-retry-cap** | B5 (code) | `src/agents/agent-tools/engineering.ts`, tests | per-turn failure cap + RED→GREEN tests |
| **SA-3 marketing-shortform** | B1 | `src/agents/prompts/marketing.ts` (+ golden task) | prompt override + assertion test |
| **SA-4 battery-harden** | B3 + new hard tasks | `scripts/e2e-hard-battery.ts` | `/reset`+ACK isolation + ≥20-task harder battery |

Each agent: **failing test first**, then fix, then `pnpm test` for its scope green + `tsc --noEmit` clean. Orchestrator integrates → full `pnpm lint && pnpm test && tsc` → verify prod `GITHUB_TOKEN` over SSH → run the harder battery live over MTProto.

---

## Reverification design

- **New harder battery** (`scripts/e2e-hard-battery.ts`): ≥20 tasks. Must re-test the fixed cases (H08 short-form draft, H10 injection-echo, H16 self-referential, H09/H15/H17 github/cross-dept) PLUS new adversarial variants (nested injection, multi-step cross-dept fan-out, planted-fact contamination retest).
- **Layer A** `structuralScore()` — deterministic hard gate (unchanged).
- **Layer B** `judgeReply()` — content judge via `openrouter:openai/gpt-oss-120b` (paid, cheap, OpenAI family ≠ Gemini drafter → satisfies rule #6; paid slug avoids the free-tier 50-RPD 429 that broke the prior run). Fail-open. **Confirm the exact slug responds before the full run.**
- **Evidence standard (rules #19/#24):** for each task — the exact bot reply + the matching `action_log` row (or explicit NO ROW) + the judge verdict. `action_log` send-count delta must stay 0 for all read-only/adversarial tasks.
- **Report:** write `docs/qa/HARD-BATTERY-2026-06-29-v2.md` with the score table + bug-closure ledger.

## Carryover follow-through
- `pnpm brain:sync` to push the QA docs to turicks-brain.
- Update `PROD_DOTENV` GH Actions secret with current `TELEGRAM_TESTER_SESSION` so CD doesn't clobber the MTProto session.
