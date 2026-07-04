# Fable 5 Reliability Audit Log — started 2026-07-03

One lesson per entry. Summary line first. Wrong entries get deleted, not amended.

## 1. The "refuse" bug is the gateway's own guard stack, not the model

**Summary:** `detectUnbackedMemoryClaim` flags ANY non-refusal reply to a prompt matching `INTERNAL_KNOWLEDGE_RE` (bare `turicks|naggar`, "our …plans/goals/pricing") when no memory tool ran — no length threshold — then office-run retries the whole invoke and finally REPLACES the reply with the brain-sync refusal.

Deterministic repro (no LLM, $0): `node --env-file=.env --import tsx/esm scripts/probe-guard-misfire.ts` — the exact T35 QA prompt plus two ordinary founder questions are all flagged `memory` against correct replies. Verified independently by a fresh-context subagent. The guard cannot distinguish "answered from the live conversation" from "fabricated from training data" because it only sees (user text regex) × (tools called) × (reply regex). This is why the guard file has 17 fix commits and never converged: every fix adds another exception regex (`ACTION_REQUEST_RE`, `SELF_REFERENTIAL_RE`, `WEB_META_REFUSAL_RE`) to a classifier that is structurally information-starved.

## 2. PR #261's recovery pass feeds the model mutually contradictory directives — and bypasses the guard

**Summary:** For the T35 prompt, `buildOfficeInput(buildRecoveryInput(text))` composes: grounding directive ("facts MUST come from tool output THIS turn, NEVER from what you know") + routing directive ("Transfer to research first") + loop-recovery directive ("Do NOT transfer more than once; answer EVERY part from what you already know"). Every branch the model can take violates one directive.

Verified by printing the composed messages (office-run.ts:990, pre-router). The recovered reply then goes straight to `sendResult` with no `needsExecutionGuardRetry` — the recovery path mandates and delivers exactly the from-memory answer the normal path deletes. Two subsystems merged 4 days apart enforce opposite policies on the same input.

## 3. The supervisor has no cross-provider fallback; provider errors kill the whole turn

**Summary:** office.ts:85 gives the supervisor a bare `getModel()` (maxRetries:2, same provider); `getModelFallbackMiddleware()` is wired only to departments. 4/4 live probe runs this session died on the supervisor's FIRST call (OpenRouter 429 ×3, 404 ×1) with an unhandled throw → "❌ Error" to the founder.

Also: `AGENT_FALLBACK_MODELS` includes `nousresearch/hermes-3-llama-3.1-405b:free`, which has **no tool-use endpoints** (404 "No endpoints found that support tool use") — that fallback slot can never work for this system.

## 4. Pre-interrupt() code is NOT pure in the outbound tools

**Summary:** `send_email` and `linkedin_post` run the LLM brand judge (`judgeOutbound`) and mutate a retry counter (`recordBrandFailure`) BEFORE `hitlGate`. Judge cache TTL = 5 min; HITL approval TTL = 24 h. An approval tapped >5 min after the card re-runs the judge on resume; a flipped verdict returns "Revise before sending" — the approved email silently never sends.

hitl.ts:11-14 documents the purity contract ("Code BEFORE the gate runs twice — keep it pure"); comms.ts violates it. Mitigations: judge is fail-open (no key → pass), so the bug needs the judge enabled + a nondeterministic verdict flip. `hasRecentOutboundToRecipient` and the daily-quota read are also impure pre-gate.

## 5. The eval — the only harness testing the layer where the bugs live — never gates a merge

**Summary:** ci.yml runs the eval only post-merge on main and silently skips it when the Google key is absent; required checks are lint/types + unit tests only; 0 required reviewers; EVAL.md last regenerated 2026-06-11 (22 days stale at audit time). PR #256 ("close the refuse/loop bug class structurally") is still OPEN — it never reached prod, so it could not have fixed anything there.

Caution for the fix: making the eval a HARD required check would flake — EVAL.md itself documents temp-0 nondeterminism and historical 79–90% swings, and each run costs paid API. Record-on-PR with a soft threshold (or required-with-one-retry) fits better.

## 6. Blocked: live LLM loop reproduction (honest gap)

**Summary:** Could not complete a live end-to-end loop repro this session — OpenRouter free tier was upstream-rate-limited (429 with retry-after on llama-3.3-70b and qwen3-next; hermes 404s on tool-use). The loop's live existence rests on the repo's own primary artifacts (loop-recovery.ts header documents the live T35 finding; commit da383ae) plus the deterministic mechanism traced in entries 1–3, not on a fresh live run.

## 7. Surgical, not wholesale: the fabrication threat the guards target is real

**Summary:** docs/qa/HARD-BATTERY-2026-06-29.md H14 records a fabricated "$42,000 MRR from 11 retainer clients" delivered DESPITE the guards, and B4/H16 record the guard overwriting a correct answer. Both failure directions are live. The high-precision detectors (`replyHasUnbackedBusinessSpecifics`) are worth keeping as inline caveats/logging; the broad flag-anything memory guard and the reply replacement are the parts that misfire.

## 8. Fix pass (2026-07-04): all four defects closed on `fix/guard-precision-release`

**Summary:** F1 guard narrowed to high-precision fabrication signals (flag-anything + `length>=80` catch-all removed; H14 $-metrics/ICP-prose/fabrication-bridge/self-query still flagged); F2 recovery input isolated from grounding/routing/ledger directives (`buildRecoveryOfficeInput`) + recovered reply now passes the guard; F3 provider capacity/quota/no-tool-use errors surface honestly (no raw stack) + fictional hermes fallback replaced; F4 judge cache TTL 5min→24h matching HITL window.

Evidence: probe-guard-misfire now `clean (delivered)` ×3 (was `memory` ×3); 1690/1690 tests green incl. new regression suites; tsc clean; live T35 probe on real graph + prod model completed in ONE pass with grounded honest reply. Model-upgrade question answered: NO — refuse class reproduces with zero LLM; upgrade (already trialing 2.5 Pro, #257) only reduces loop frequency.
