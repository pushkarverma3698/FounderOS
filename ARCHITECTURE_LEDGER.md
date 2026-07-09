
---

# PART 2 — v3 Kernel Production Pass (branch `claude/founderos-v3-production-gea8pn`)

## Entry 7 — v3 baseline audit (2026-07-08)

**Problem.** Founder directive: run the same production-readiness protocol against the NEW
v3 architecture. The v3 kernel rebuild lives on `beta` (commit a53a6f2, PR #291) — a
-26,583/+5,063 line slim-down introducing `src/kernel/` (contracts, planner, supervisor,
worker, synthesizer, tool-adapter, graph, signals, state). `main` meanwhile carried on the
v2 line (51 commits ahead of the merge base, incl. PR #292's runtime state proof).

**Options for the branch base.**
1. Base on `main` and merge beta in — produces the exact "dirty 51-commit PR" the previous
   session hit and reverted. Rejected.
2. Base on `origin/beta` — the v3 kernel line itself; the production pass verifies v3 as it
   will actually ship, and the PR diff shows only this session's fixes. **Chosen.**
   (The designated branch had zero unique commits — it was identical to origin/main — so
   resetting it onto beta loses nothing.)

**Measured v3 baseline (fresh `pnpm install --frozen-lockfile`, all run this session):**
- `pnpm lint` (tsc --noEmit): exit 0
- `pnpm test`: 120 files / 1222 tests, all green
- `pnpm build` (tsc emit): exit 0 — NOTE: v3 dropped the jarvis/jarvis-next apps entirely
  (`apps/` does not exist; `build:all` = `build`). There is no Next.js service on this line;
  the task's "boot Next.js" step is therefore N/A on v3 — documented, not skipped silently.
- `pnpm verify:wiring`: passed, 0 warnings
- `pnpm verify:arch` (new v3 gate): all 5 architecture gates green (gateway-imports,
  kernel-purity, fail-open-catch, loc-budget, regex-routing)

**Identified v3 gaps to close (the actual work):**
1. No runtime state proof: `tests/integration/` on this line has only live-model-guard,
   log-review, signal-transaction — the gateway↔Postgres interrupt/resume state-drop proof
   (PR #292) never reached the v3 line, and v3's kernel path is exactly the code it must cover.
2. Real-Postgres verification: boot the system PG16 cluster, run the real setup/migration
   path, prove the kernel checkpointer persists and resumes state across a simulated
   Telegram payload.
3. CI: check whether beta's integration job has the same two pre-existing failure classes
   fixed on main in #292 (dead-key 402s + missing Postgres service).

---

## Entry 8 — v3 runtime state proof: seam placement + a suspected resume-state bug

**Problem.** Prove the v3 gateway loop (`runKernelText` → HITL pause → `resumeKernel`)
does not drop state, against the REAL Postgres checkpointer, with a simulated Telegram
payload — no live LLM/Telegram credentials exist in this container.

**Seam placement (adapted from Entry 4 to the v3 composition root).** `kernel-boot.ts`
imports `getModel` (planner) and `getWorkerModel` (worker + synthesizer) from
`agents/model.js` at module level, so an export-level `vi.mock` intercepts cleanly (the
Entry-5 intra-module-binding trap does not apply here — the caller is a different module).
Everything else runs REAL: `getKernel()` composition, DEPARTMENT_TOOLS with the production
`send_email` wrapper (daily quota → duplicate-outreach guard → brand gate → `hitlGate`
writing `hitl_approvals` → `interrupt()` → suppression → idempotency audit), the Postgres
checkpointer, and the full kernel graph. Faked at the credential boundary only:
`providerSendEmail` (Gmail transport) and `judgeOutbound` (fail-open Claude judge, would
otherwise attempt a live call). Scripted models discriminate by SYSTEM-PROMPT CONTENT
(synthesizer prompt vs worker protocol), not call order — invariant under graph topology.

**Options for the model fake.** (a) Reuse kernel-e2e's `buildKernel` injection — rejected:
that bypasses `kernel-boot.ts`/`getKernel()`, the exact composition root under test.
(b) Mock at `agents/model.js` — chosen: `runKernelText` then exercises every production
line from the grammy seam down.

**Suspected bug to prove/disprove (red repro first, rule #19).** `resumeKernel` resolves
the `hitl_approvals` row BEFORE `kernel.invoke(Command{resume})`. On resume the gated tool
re-executes from the top (documented interrupt() semantics) and `hitlGate` re-runs:
`getPendingInterrupt` now finds nothing (just resolved) → it INSERTS A FRESH `pending` row
→ `interrupt()` returns "approved" and the turn completes — leaving an ORPHAN pending row.
Consequences if real: `restorePendingApproval` re-posts a stale approval card after any
restart within 2h, and the next callback tap "resolves" a phantom. The test asserts
zero pending rows for the thread after a completed resume; if that fails, the fix will be
designed in a follow-up entry before touching code.

---

## Entry 9 — CONFIRMED v3 bug: orphan pending `hitl_approvals` row after every approved resume

**Symptom (red repro, this session).** The new integration test's turn-2 assertion
"zero pending rows after a completed resume" fails: one orphan `pending` row remains.

**Root cause.** `resumeKernel` resolves the pending row BEFORE `kernel.invoke(Command{resume})`.
LangGraph then re-executes the gated tool from the top; `hitlGate` re-runs, finds no pending
row (just resolved), inserts a FRESH one, and `interrupt()` returns the resume value. The turn
completes with a phantom `pending` row. Consequences: `restorePendingApproval` re-posts a stale
approval card after any restart within 2h, and the next tap "resolves" a phantom — the exact
wedged-interrupt bug class rule #19 exists for.

**Options considered.**
1. Reorder: resolve AFTER invoke. Leaks anyway in the pause-again case (a second gated step
   skips its own insert because step-1's row is still pending, then orphans on ITS resume) —
   and loses the "decision durably recorded before side effects" property. Rejected.
2. `hitlGate` skips insert when the latest resolved row matches this payload — time/content
   heuristics, breaks legitimately-repeated approvals (shell commands), flaky. Rejected.
3. Transport-layer reconciliation (CHOSEN): the graph checkpoint is the source of truth for
   "paused". In `resumeKernel`, after the post-invoke approval check says the graph is NOT
   paused, any still-pending DB row for this thread is by definition the re-execution
   artifact — resolve it with the founder's decision. Deterministic, no change to hitlGate's
   rule-#4 crash-recovery write, covers single- and multi-gated-step missions uniformly.
   Fail loud: a DB error here surfaces via the existing typed error reply, no swallowed catch
   (also keeps the verify:arch fail-open-catch ratchet at baseline).

**Known limitation (documented, not hidden):** when a mission pauses AGAIN on a second gated
step, the surviving pending row still carries step-1's callback_data, so a crash-restore card
between the two approvals shows the previous step's payload. Pre-existing behaviour, separate
bug class, not widened by this fix.

**Also fixed in the test harness (not product code):** the reject-path scenario must use a
DIFFERENT recipient — the duplicate-outreach guard (correctly) short-circuits a second send to
the just-emailed address BEFORE the HITL gate, so the mission completes without pausing.
The scripted planner/worker now parse the recipient from the message instead of a constant.

---

## Entry 10 — v3 verification results (2026-07-08, every command run fresh in this session)

**Runtime environment booted for the proof:**
- System PostgreSQL 16.13 started (`pg_ctlcluster 16 main start`), `postgresql-16-pgvector`
  installed (extension `vector 0.6.0` verified with a real `CREATE EXTENSION`), `founderos`
  role + database created to match `.env.example`, and the REAL migration path run
  (`scripts/setup-db.ts`): 17 tables in `agents` (incl. LangGraph `checkpoints` /
  `checkpoint_writes` / `checkpoint_blobs`), 4 in `brain` — verified with `\dt`, not assumed.

**Simulated Telegram payload, real v3 path, real Postgres**
(`tests/integration/kernel-postgres-state.test.ts`, 4/4 green):
1. Turn 1 (text payload → `runKernelText`): pauses on the approval card ("Send email to …?",
   Approve/Reject keyboard), `hitl_approvals` row `pending`, >0 checkpoint rows for the thread,
   transport NOT called.
2. Turn 2 (approve → `resumeKernel`): transport fires exactly once with the turn-1 payload,
   `action_log` idempotency row written (`email:turicks:<sha1-16>`), approval row resolved,
   ZERO pending rows remain (Entry-9 fix verified), reply carries the code-side receipts
   block, and the thread still holds the turn-1 mission with `status: done` — state NOT dropped.
3. Replay with the same idempotency key skips (`skipped: true`), transport still exactly once.
4. Reject path: typed `hitl_rejected` reply ("Nothing was sent"), NO transport call, row
   `rejected`, no orphans.

**Gates (fresh runs, in order):**
- `pnpm lint` → exit 0
- `pnpm test` → 120 files / 1222 tests green (incl. the changed `resumeKernel`)
- `pnpm build` → exit 0
- `pnpm verify:wiring` → "✅ … fully wired (0 warning(s))"
- `pnpm verify:arch` → all 5 ratchets = baseline (the Entry-9 fix adds NO fail-open catch)
- `pnpm test:integration` → 3 files / 7 tests green (new suite + signal-transaction both
  RUNNING against the real local Postgres, not skipping)
- `pnpm test:smoke` → keyless env (CI condition): clean SKIP exit 0; with this container's
  placeholder .env: FAILS LOUD ("no openrouter key … office is dead") — the boot validator
  doing its job.

**NOT VERIFIED (named per the accountability protocol):** live Telegram round-trip (no real
bot token — grammy `getMe` cannot authenticate), live LLM planning/routing (`pnpm eval`; no
OpenRouter/Gemini key in this container), real Gmail transport, and MTProto founder-simulation
QA. Every layer beneath those credentials was exercised for real. Additionally N/A on v3:
there is no Next.js app on this line (`apps/` was removed by the kernel rebuild).

---

## Entry 11 — Replacing production (main, v2) with the v3 kernel line

**Problem.** Founder directive: "replace main with new architecture v3." `main` (v2) has 51
commits the v3 line never saw; `stable` has its own unique history; the CI-enforced ladder
only allows work → beta → stable → main. A naive beta→main merge conflicts across the whole
v2/v3 surface.

**Options considered.**
1. Merge main into beta resolving file-by-file — hundreds of conflict hunks across files v3
   deliberately deleted; every manual hunk is a chance to resurrect tombstoned v2 modules
   (verify:arch would catch some, not all). Rejected.
2. Force-push beta over main — violates the repo's own "never commit to main / only humans
   merge via the ladder" governance and silently orphans main's history. Rejected.
3. `git merge -s ours` (CHOSEN): from a work branch on beta, record merges of origin/main and
   origin/stable that keep the v3 TREE byte-identical while making both histories ancestors.
   The founder's decision "v3 replaces v2" is encoded exactly: v2's history is preserved,
   v2's content is retired. After this lands in beta, beta ⊇ main ∧ beta ⊇ stable, so the
   ladder promotions (beta→stable→main) become content-clean merges with zero conflict hunks.
   Deploy-critical main-side fixes were audited first and already exist on beta: the
   anthropic model pin in deploy.yml, scripts/apply-prod-env-overrides.sh, and the
   pgvector/pgvector:pg16 prod image in deploy/stack.compose.yml.

**Safety check before pushing:** the work branch's tree hash must equal origin/beta's tree
hash — proving the merge changed NOTHING in v3 content. The ladder PRs must be MERGE-merged
(not squashed): squashing flattens the merge commit and loses the recorded ancestry, which
would re-conflict stable→main.

---

## Entry 12 — main's CI was already red: the eval job depends on absent repo secrets

**Symptom.** Every push to main fails CI at "Eval + update README metrics" — including the
two v2 pushes BEFORE the v3 promotion (runs #843, #853) and the v3 merge itself (#863). The
three real gates (quality, unit+regression, integration) are green; the eval job dies in
config validation: `DATABASE_URL: Invalid url`, `TELEGRAM_BOT_TOKEN/CHAT_ID: empty` — the
job reads them from repo secrets that are not set.

**Why it matters.** deploy.yml auto-fires only on CI success for main, so a permanently red
eval job silently disables auto-deploy forever — the exact "red check reviewers learn to
ignore" failure class Entry 6 named. (v3 shipped anyway via deploy.yml's workflow_dispatch
escape hatch, which re-runs lint+build as preflight — nothing unverified was deployed.)

**Options.**
1. Ask the founder to add DATABASE_URL/TELEGRAM secrets — but the eval needs a THROWAWAY
   database, not a production one; pointing the eval at prod Postgres from a CI runner would
   be actively wrong, and placeholder Telegram values as "secrets" is configuration theatre.
2. Make the job self-sufficient (CHOSEN): give it the same pgvector service container +
   placeholder Telegram env the Integration-tests job and live-e2e.yml already use, and run
   the real `scripts/setup-db.ts` migration before `pnpm eval`. The live LLM key still comes
   from secrets (that part is real and present). This mirrors live-e2e.yml exactly — same
   proof, same env pattern, zero new secrets.

**Verification:** js-yaml parse of ci.yml + the next main push must show the eval job either
green or failing on a REAL eval regression (accuracy gate), never on missing env.
