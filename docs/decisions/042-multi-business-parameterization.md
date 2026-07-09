# ADR-042: Multi-Business Parameterization (bounded, not SaaS)

**Status:** Accepted · **Implemented** 2026-06-27
**Builds on:** ADR-036 (account registry — per-company credential resolution), ADR-021 (cacheable prefix / context isolation)
**Scope:** Phase 4 of the Production-Grade 1.0 program.

## Context

The account registry (ADR-036) already resolves credentials per company
(`turicks`, `personal`, `naggar`). The remaining gap was that the **agent voice**
was hardcoded to Turicks — the supervisor + department prompts only knew how to
speak as Turicks. Running a *second* business (Naggar Retreat) through the same
locked graph required parameterizing identity/voice/ICP without rearchitecting
the supervisor and without the deferred SaaS rebuild (auth, billing, RBAC,
per-user entities — all still Phase-E deferred).

## Decision

**Inject a per-turn company-context override as a `SystemMessage`, rather than
building prompt factories.**

A prompt-factory approach (interpolating company brand voice into
`SUPERVISOR_PROMPT` / `COMMS_PROMPT` / `MARKETING_PROMPT` / `SALES_PROMPT`) would
have broken the byte-stable cacheable prefix (rule #20 / ADR-021), defeating
Gemini implicit caching. Instead:

- `src/core/companies.ts` — a pure registry (`CompanyProfile`) of public
  identity + brand voice + audience + which knowledge store holds the facts.
  `buildCompanyContextBlock(company)` returns **`""` for the default boot tenant**
  (Turicks) — so production behavior and the cacheable prefix are byte-for-byte
  unchanged — and an explicit override block for any non-default company.
- `src/gateway/active-company.ts` — in-memory per-thread `chatId → companyKey`
  map (durable persistence is Phase-E). Pure accessors.
- `src/gateway/pre-router.ts` — `buildOfficeInput(text, companyKey?)` prepends the
  override `SystemMessage` (ahead of any routing directive) only when non-empty.
- `src/gateway/commands.ts` — `/company [key]` shows or switches the active
  business for the thread; defaults to `FOUNDER_TENANT`.

### Anti-fabrication (rule #22)

The override block NEVER invents ICP bands, clients, or numbers. It states the
public identity + voice and points at the company's knowledge store for the
specifics, deferring to the department tools to fetch them.

## Consequences

- **Same locked graph, two voices.** Credentials resolve per-company (ADR-036);
  voice is now parameterized too. Adding a business = one `CompanyProfile` entry
  + an `ACCOUNT_SEED_SPECS` account.
- **Zero regression for Turicks.** Default tenant emits an empty override; all
  existing routing/HITL tests stay green untouched.
- **Cache-stable.** No volatile data injected ahead of the stable prefix.
- **Explicitly deferred to Phase E:** auth, billing, per-user Composio entities,
  RBAC/role-based approvals, parallel per-company execution, durable per-thread
  company persistence, job queue.

## Verification

- `pnpm lint` (tsc --noEmit) clean; full suite green (1498 tests) incl. new
  `tests/unit/core/companies.test.ts`, `tests/unit/gateway/active-company.test.ts`,
  and company-injection cases in `tests/unit/gateway/pre-router.test.ts`.
- Live dogfood (MTProto): `/company naggar` → a Naggar task speaks in Naggar voice
  and resolves Naggar credentials; a Turicks task is unchanged — to be run once at
  PR-ready per cost rule #23.
