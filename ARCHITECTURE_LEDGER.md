# ARCHITECTURE_LEDGER

Reasoning dump for the production-readiness pass (branch `claude/founderos-production-ready-az0y06`).
Each entry: problem → options → why this implementation.

---

## Entry 1 — Baseline audit (2026-07-08)

**Problem.** Establish whether the repo actually compiles/passes before changing anything, so
fixes target real failures rather than assumed ones.

**Measured baseline (fresh clone, `pnpm install --frozen-lockfile`):**
- `pnpm lint` (tsc --noEmit): **clean, exit 0**
- `pnpm test` (vitest): **163 files / 1648 tests, all green**
- `pnpm build` and `pnpm build:all` (core tsc emit + jarvis Vite + jarvis-next Next 15): **all pass**
- `pnpm verify:wiring`: **passed, 0 warnings**

**Conclusion.** The codebase compiles and the deterministic CI gates are already green.
The remaining production-readiness gap is the *runtime* proof: no `.env` exists here, Docker
daemon is not running, and no LLM API keys are available in this container. The work is
therefore: (a) boot a real local Postgres, (b) run the real migration/setup path against it,
(c) drive a simulated Telegram payload through the real gateway → graph → checkpointer path
and prove state survives (interrupt/resume), (d) leave CI passing.

---

## Entry 2 — Booting PostgreSQL without Docker

**Problem.** `docker compose up -d postgres` is the documented path, but the Docker daemon is
not running in this container (`/var/run/docker.sock` absent). The runtime proof needs a real
Postgres with the schema applied.

**Options considered.**
1. Start `dockerd` manually — heavyweight, may not work in a nested/unprivileged container,
   and adds nothing over a direct Postgres.
2. Use the preinstalled system PostgreSQL 16 (`/usr/lib/postgresql/16`) via `pg_ctlcluster`,
   create the `founderos` role/db to match `.env.example` defaults.
3. Skip a real DB and mock the checkpointer — explicitly forbidden by the task (zero-trust
   execution) and by project rule #22 (verify real state, not schema).

**Chosen: option 2.** It gives a genuine Postgres 16 the same major version as the pgvector
prod image, needs no daemon privileges, and the connection string can mirror
`docker-compose.yml` defaults so `scripts/setup-db.ts` and drizzle migrations run unmodified.
Known limitation to verify: the system Postgres may lack the `vector` extension (prod uses
`pgvector/pgvector:16`). If `CREATE EXTENSION vector` fails, the RAG tables are the only
casualty — document it, don't fake it.

---

## Entry 3 — Simulated Telegram payload without live keys

**Problem.** Prove the system "can handle a simulated Telegram payload without dropping
state." A full live boot (`src/index.ts`) requires a real `TELEGRAM_BOT_TOKEN` (grammy calls
`getMe` against api.telegram.org) and a real LLM key — neither exists in this container.

**Options considered.**
1. Boot `src/index.ts` with placeholder token — fails at grammy `bot.init()` with 401;
   proves nothing past config validation.
2. Drive the office invoker directly (`scripts/probe-real-task.ts` style) — exercises the
   graph but bypasses the gateway run-loop, which project rule #19.3 identifies as the
   highest-risk code. Insufficient alone.
3. A verification script that boots the REAL gateway pipeline (the same handler wiring
   `telegram.ts` uses) against the REAL local Postgres, with exactly two fakes at the
   process boundary: the Telegram transport (grammy outbound API) and the LLM model.
   Everything between — routing, HITL `hitl_approvals` DB write, `interrupt()`, checkpointer
   persistence, resume, idempotency audit — is the production code path.

**Chosen: option 3.** The boundaries faked are exactly the two that require external
credentials; all state-carrying logic runs for real against Postgres. The state-drop check is
concrete: turn 1 sends a payload that triggers a HITL interrupt (row in `hitl_approvals` +
checkpoint row in Postgres), the process-level state is then re-read, turn 2 resumes the
same thread, and the audit row must appear exactly once. That is the strongest verifiable
claim available without live Telegram/LLM credentials — anything stronger would be fabricated
evidence. NOT VERIFIED live-Telegram/live-LLM paths are named as such in the final report.

---

## Entry 4 — Mock boundaries for the simulated-payload test (exact placement)

**Problem.** Pick the mock seams so the test proves the production path rather than a
mocked shadow of it. A mock placed one layer too high silently excludes the logic under test
(this repo's rule #19 history: green suites that never touched the real run-loop).

**Boundaries considered, and what each would exclude:**
- Mock `agents/office.js` (like the unit gateway tests) → excludes the graph, checkpointer,
  HITL wrapper entirely. Rejected — that's the unit suite's job, already green.
- Mock `tools/email.js` (`emailTool`) → excludes `hasBeenAudited`/`writeAuditEntry`, i.e. the
  idempotency audit this test must prove. Rejected.
- Mock `infra/providers/index.js` (`providerSendEmail`) → excludes ONLY the Gmail HTTP
  transport. Everything above it — quota check, duplicate-outreach guard, brand gate,
  `hitl_approvals` insert, `interrupt()`, Postgres checkpoint persistence, resume,
  suppression check, idempotency audit to `action_log` — runs for real. **Chosen.**
- Model: mock `agents/model.js#getModel` with a scripted `BaseChatModel` that decides by its
  *bound tool set* (has `send_email` → comms dept; has `transfer_to_comms` → supervisor),
  not by call order. Rationale: one shared model instance serves supervisor + 8 departments,
  so a sequence-queue fake would couple the test to LangGraph's internal invocation order —
  brittle. Tool-set detection is invariant under graph topology changes.
- Judge: mock `infra/judge.js#judgeOutbound` → deterministic "pass". It is fail-open by
  design (ADR-023) and would otherwise attempt a live OpenRouter call from inside the test.

**Placement:** `tests/integration/gateway-postgres-state.test.ts` — the integration config is
the suite that documents "hits a real Postgres checkpointer" and is CI-gated, and the file
skips itself (runIf) when Postgres is unreachable so it can never break keyless CI. Unlike the
other integration suites it needs NO live LLM key — the graph is real, the model is scripted.

**State-drop proof (what "without dropping state" means here, concretely):**
1. Turn 1 (simulated Telegram text payload → `routeToOffice`): approval card replied;
   `hitl_approvals` row `pending` in Postgres; ≥1 row in `agents.checkpoints` for the thread.
2. Turn 2 (simulated approve callback → `resumeOffice`): resume value reaches the paused
   tool; `providerSendEmail` called exactly once; `action_log` row with the deterministic
   idempotency key exists; `hitl_approvals` row resolved `approved`; final reply delivered;
   original HumanMessage still present in thread state (history preserved across the pause).

---

## Entry 5 — Verification results (2026-07-08, all commands run fresh in this session)

**Failures hit while building the runtime proof, and their fixes** (both were test-harness
bugs, not product bugs — the product code behaved correctly each time):

1. **`401 Missing Authentication header` inside the comms agent.** Mocking `getModel` alone
   was insufficient: departments use `getWorkerModel()`, which internally calls the
   module-local `getModel` binding — an export-level mock cannot intercept an intra-module
   call. Fix: mock `getWorkerModel` (and `getModelFallbackMiddleware`) directly.
2. **`GraphRecursionError` ("stuck in a loop") on turn 1.** Root cause chain: an earlier
   failed run's idempotency sub-test had written a REAL `action_log` row for the recipient →
   the duplicate-outreach guard (`hasRecentOutboundToRecipient`) correctly blocked the send →
   the scripted model naively re-emitted the identical tool call forever. Two fixes: unique
   recipient per run (`alex+<ts>@example.com`) so cross-run audit rows can never collide, and
   the scripted comms model is now terminal on ANY tool result (reports the outcome instead of
   retrying). Notably the product's recursion guard caught the loop, aborted, cleared the
   thread, and told the founder — exactly the designed fail-safe behaviour.
3. Trivial: asserted a nonexistent `action` column on `hitl_approvals` — dropped.

**Final evidence (each command run in this session, in this order):**
- `pnpm lint` → exit 0 (tsc clean, includes the new test)
- `pnpm build` + `pnpm build:all` → exit 0 (core tsc emit, jarvis Vite, jarvis-next Next 15 prod build)
- `pnpm verify:wiring` → "✅ Wiring check passed — registry is fully wired (0 warning(s))"
- `pnpm test` → **163 files / 1648 tests passed**
- `pnpm test:integration` → **3 files passed (incl. the new gateway-postgres-state suite:
  3/3), 4 skipped** (the skipped suites require a live LLM key — honest skip by design)
- `pnpm test:smoke` → keyless (CI condition): "SKIP … clean skip, not a failure", exit 0.
  With this container's placeholder .env: FAILS LOUD ("no openrouter key … office is dead") —
  that is the boot validator doing its job; this container has no live keys.
- PostgreSQL 16.13 booted locally (system cluster + `postgresql-16-pgvector`), `founderos`
  db created, `scripts/setup-db.ts` ran the real migration path: 17 tables in `agents`
  (incl. LangGraph `checkpoints`/`checkpoint_writes`/`checkpoint_blobs`), 4 in `brain`.
- Next.js (`apps/jarvis-next`) production server booted → `GET / → HTTP 200`.
- Simulated Telegram payload, real path, real Postgres: turn 1 pauses on the approval card
  with a `pending` row in `agents.hitl_approvals` and >0 rows in `agents.checkpoints`;
  turn 2 (approve) fires the transport exactly once, writes the `action_log` idempotency row
  (`email:turicks:<sha1-16>`), resolves the interrupt to `approved`, and the thread still
  holds the turn-1 HumanMessage (state NOT dropped). Replay of the approved action skips on
  idempotency. 3/3 green.

**NOT VERIFIED (named per the accountability protocol):** live Telegram round-trip (needs an
MTProto session + real bot token), live LLM routing/eval (`pnpm eval`, needs a paid or free
OpenRouter key), and real Gmail transport — none of these credentials exist in this container.
The paths above them were exercised for real; the credentials are the only missing layer.

---

## Entry 6 — CI integration job: two pre-existing failure classes (found via PR #292)

**Problem.** The `Integration tests` CI job fails on every run where the repo's secrets are
configured, for reasons unrelated to any PR's diff:
1. `office-hitl.test.ts` (5 tests): the CI `OPENROUTER_API_KEY` is real-looking but has **zero
   credits** — `hasLiveIntegrationModel()` only checks key *presence*, so the suite runs live
   and every call dies with `402 Insufficient credits`.
2. `signal-transaction.test.ts` (2 tests): needs a real Postgres, but the job defines
   `DATABASE_URL=postgresql://ci:ci@localhost:5432/ci` with **no Postgres service container**
   → `ECONNREFUSED`. (The new gateway-postgres-state suite skipped cleanly in the same run —
   confirming its reachability probe works — but skipping means no CI coverage.)

**Options considered.**
- Do nothing / report only — leaves the job permanently red; every future PR shows a failing
  check that reviewers learn to ignore. Worst outcome for a repo whose rules are built on
  "no false green, no ignored red".
- For (1), auto-`skip` inside each test on 402 — scatters error-classification through test
  bodies. Instead: one async guard, `hasUsableLiveIntegrationModel()`, that makes a single
  minimal live probe call and skips the whole suite LOUDLY (with the provider's reason) when
  the provider is unusable. A depleted key is equivalent to an absent key for test purposes;
  the prod boot validator (`test:smoke`) still fails LOUD on a dead provider, so no safety
  regression. Cost: one tiny probe per CI run, only when keys are configured (rule #23 ok).
- For (2), add a `pgvector/pgvector:pg16` service container (same image as prod
  `deploy/stack.compose.yml`) + run the real `scripts/setup-db.ts` before the suite. This
  turns BOTH Postgres-dependent suites from dead weight into real CI coverage — the new
  gateway-postgres-state suite now runs on every keyed CI run instead of skipping.

**Chosen:** async probe guard + Postgres service. Branch policy check (PRs to main must come
from `stable`) stays red by design: `beta` has diverged onto the v3 kernel line while this
work is on main's v2 line (retargeting to beta produced a dirty 51-commit PR — reverted).
Routing the merge is the founder's call; the check exists precisely to force that decision.

**Entry 6 verification (fresh runs):**
- `pnpm lint` → exit 0; ci.yml parses (js-yaml OK)
- CI-equivalent simulation (clean env: fresh `ci` Postgres db, job env vars only, no LLM keys):
  `scripts/setup-db.ts` → "Database setup complete"; `vitest --config vitest.integration.config.ts`
  → **3 files passed | 4 skipped** (gateway-postgres-state + signal-transaction now RUN and pass)
- Probe-failure path exercised with a real provider error (real-looking invalid OpenRouter key):
  `[live-model-guard] SKIP live suites — provider probe failed: 401 User not found.` →
  office-hitl 5 skipped instead of 5 failed. The CI 402 takes this identical catch path.
  NOT VERIFIED against the literal 402 (needs the repo's actual depleted key).
- `pnpm test` → 1648/1648 green after the changes.
