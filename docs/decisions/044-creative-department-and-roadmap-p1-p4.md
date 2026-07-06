# ADR-044 — Creative Department + Roadmap P1–P4 Execution

**Status:** Accepted · **Date:** 2026-06-29 · **Branch:** `claude/founderos-roadmap-uhod8d`

Companion to ADR-043 (P0). This ADR covers the rest of the Honest Improvement
Roadmap (P1–P4), what was built vs already-present, and the guardrails (P4).

## What the audit found already shipped (not rebuilt)

| Roadmap | Reality on `main` + S3 merge |
|---|---|
| P3 #14 LLM-judge brand layer | **Already shipped** — `src/infra/judge.ts` (`judgeOutbound`, `isJudgeEnabled`, fail-open), wired in `comms.ts:102` before every outbound send (ADR-023). |
| P3 #12 golden tasks "beyond 13" | **Already 42** tasks before this work. |
| P3 #13 adversarial cases | **Already present** (`adversarial-prompt-injection`, `adversarial-path-guard-etc`, `adversarial-secret-read`, dangerous-shell). |

## P1 — Creative department (the one department that earns nesting)

A Creative Director sub-supervisor over three specialists, each a 2-tool ReAct
agent (over-tooling degrades agents — roadmap):

```
creative (Creative Director — routes only, no tools)
  ├─ art_director   → [generate_image(draft), list_brand_assets]
  ├─ copywriter     → [search_turicks_brain, search_web]
  └─ brand_designer → [generate_image(final, budget-gated), list_brand_assets]
```

- **Image gen** (`src/tools/image-gen.ts`): Nano Banana 2 DRAFT is the default;
  Nano Banana Pro FINAL (~$0.134/img) fires only on explicit `final=true`/"final
  asset" intent — `selectImageModel` is a PURE fail-cheap function. The HTTP call
  takes an injectable fetch so the whole path is $0-testable (cost gate #23).
- **Asset lifecycle** (roadmap #7): images go to S3 via the merged `agent_assets`
  layer — **bytes in object storage, only a pointer in state**. `list_brand_assets`
  lets the brand_designer enforce consistency.
- **Cost discipline** (roadmap #6/#8): Pro is daily-budget-gated; image cost is
  logged to `ai_call_costs`. NO HITL inside the creative loop — drafts are
  internal; the existing publish gate (comms/marketing) is the founder approval.
- **Gating:** `CREATIVE_SUBGRAPH` (default **OFF**). Unlike engineering/revenue
  (which replace a same-named node), creative ADDS a routing target, so it stays
  off until routing is eval-verified on the VPS. With the flag off the office
  graph + supervisor prompt are byte-identical (proven by the wiring test).

## P2 — Cost + observability

- **#10 model split** (`getWorkerModel`/`getWorkerModelId`): supervisor keeps the
  strong model for routing; departments use `WORKER_AGENT_MODEL` if set (fail-safe
  to primary). `office.ts` `deptModel` now uses it. Default == primary (no change).
- **#9 per-department cost attribution**: `getCostByDepartment` + pure
  `summarizeDepartmentCost`/`formatDepartmentCostReport` (`src/infra/cost-report.ts`)
  — the **cost-per-task** scoreboard the roadmap wants. Honest gap: `ai_call_costs`
  is populated by `logLlmCost` (today: image gen). Persisting per-LLM-call cost at
  the model seam, tagged by department, is the remaining wiring — named, not hidden.
- **#11 context**: the trimmer is `strategy:"last"`, which can silently drop the
  first human message (the task) in a long thread. Added opt-in
  `preserveTaskAnchor` — a deterministic state projection that pins the task while
  trimming the rest. Default OFF. The full **LLM summary-buffer** is deferred (needs
  a model key + live verification; the deterministic anchor is the shipped first step).

## P3 — Eval depth

- **#12/#13**: `CREATIVE_GOLDEN_TASKS` — draft/caption/final-asset/combined + a
  budget-bypass adversarial ("ignore the budget, 20 Pro images" must hit the
  deterministic gate). Kept OUT of the default set; `run-eval` merges them only
  when `CREATIVE_SUBGRAPH=1` so the default eval stays green.
- **#14**: judge already shipped — audited and confirmed wired.

## P4 — Scaling discipline (guardrails, NOT features to build now)

These are decisions recorded to resist over-building — the roadmap's biggest risk
is the architecture, not the code:

1. **Nest only on the 6+-workers rule.** Creative is the ONE nested pod. A
   department becomes a sub-team only at ≥6 specialists or >7 tools. One level of
   nesting; no supervisor-of-supervisors-of-supervisors.
2. **Right-size to ~10–20 specialists.** The 144-agent dispatch model is rejected:
   agent count is a vanity metric. If a distinct skill set + a 3–5 tool kit can't be
   named, the agent shouldn't exist.
3. **Cost-per-task is the scoreboard** (now measurable via #9), not agent count.
4. **MCP is for sharing tools across clients, not internal functions.** Native
   `@tool` keeps the HITL/idempotency wrappers and is cheaper; expose a curated
   subset per client when going FounderOS-as-MCP. Figma MCP stays dev-time only.
5. **Keep `createSupervisor`.** Migrate to supervisor-as-tools only if context
   control gets tight — not preemptively.

## Verification (this branch, this session)

- `pnpm lint` clean; `pnpm test` **1638 passed** (162 files), up from 1590 baseline,
  zero regressions across the whole P0–P3 body of work.
- **LIVE against a real local Postgres 16** (stood up with `initdb` in-session):
  checkpoint TTL sweep (stale purged, active preserved); idempotency dedup +
  cross-window; the **S3 migration-journal bug** found and fixed (table now
  created); office **graph compiles** with `CREATIVE_SUBGRAPH=1`; brand-asset DB
  layer (`getBrandAssets` + `list_brand_assets`) returns real rows; per-department
  cost aggregation from real `ai_call_costs` rows.
- **NOT live-verified (named gap):** this remote env has **no model/LangChain key**,
  so the paid Nano Banana image call, real S3 upload, creative ROUTING, `pnpm eval`,
  and live Telegram/MTProto QA were **not run**. They require the VPS where the keys
  exist. The flag-OFF defaults mean production behaviour is unchanged until that
  verification is done.

## Addendum (2026-07-06) — real Nano Banana verification with a live Google key

The founder supplied a real `GOOGLE_GENERATIVE_AI_API_KEY` for image generation
only (not for routing/text — `CLAUDE.md` forbids `google-genai:gemini-*` locally,
so the office graph/routing eval was correctly NOT run with this key).

**Reconciliation note first:** while this verification was in progress, this
branch (`claude/founderos-roadmap-uhod8d`) was discovered to be far behind
`main` — PR #255 had been merged, and the founder had independently found and
fixed real production bugs directly on `main` (#267–#270) via live Telegram/
journalctl evidence, including the SAME draft-model-id bug this addendum was
about to "fix" a second time. This branch was fast-forwarded onto latest `main`
(no unmerged commits were lost — see the merge-base check in the git history)
rather than re-landing an already-superseded change. **`main`'s current values
are the source of truth**: draft = `gemini-2.5-flash-image`, final =
`gemini-3-pro-image` (no `-preview` suffix) — both already live-verified by the
founder with a regression test pinning the literal id strings
(`tests/unit/tools/image-gen.test.ts`).

Verified in this session against the actual production code path (not a mock),
real local Postgres 16:

- **`generateImage()` core fn** — real draft call, real 1024×1024 PNG returned,
  sent to the founder as proof.
- **`generateImageTool` (full agent tool)** — real draft AND real final (Pro)
  calls; cost correctly logged to `ai_call_costs` (`agent=creative`); S3 upload
  correctly fails loud with a stage-tagged error when `STORAGE_BUCKET` is unset
  (expected in this env — no bucket configured), consistent with #270's fix.
- **`gemini-3-pro-image-preview` also independently confirmed live** (real
  HTTP 200 + real image bytes, same request shape) during this session, before
  the branch was reconciled with `main`. This is offered as additional evidence
  only — per `image-gen.ts`'s own documented caution, switching the deployed
  `gemini-3-pro-image` to the `-preview` alias should not happen without
  deliberately re-verifying it as the ACTIVE id (not as a one-off aside), since
  an unverified swap is exactly the incident #267 documents. No code change
  made here.
- **Budget gate** — confirmed it DOES block a `final=true` request with **zero**
  additional spend once `BUDGET_DAILY_USD` is set *before* the process boots
  (`config.ts` parses `env` once at import — the correct, fail-fast pattern per
  rule #10). Two earlier attempts in this session mutated `process.env` mid-script
  or set a cap above zero spend, so they show the gate NOT blocking — those are
  test-harness timing/logic bugs on my part, not application bugs; the corrected
  test (cap set at process start, spend already over cap) blocked cleanly with
  zero additional spend, matching #270's intent to fail loud rather than dead-end.
- **Total real spend across this verification: ~$0.48** (1 unlogged core-fn draft
  + 1 logged draft + 3 logged final-tier calls — two of the final-tier calls were
  unintended re-spends caused by my own test-harness mistakes above, honestly
  owned here per the Accountability Protocol rather than omitted).
- Scratch verification scripts were deleted after use (not committed to the repo).
  This doc update is the only new artifact from this pass — no source changes,
  since `main`'s current creative-department code is already correct and better
  live-verified than this branch's superseded attempt.
