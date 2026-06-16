# FounderOS — Stabilization Hardening (2026-06-16)

Goal (founder directive): **errors should surface as compile-time / CI / boot-time
failures, not as production incidents on `main`.** This pass shifts known failure
classes left without a rewrite. The architecture (LangGraph supervisor + Postgres
checkpointer + HITL) is sound; the instability came from breadth outrunning
real-path verification, so the fixes are guardrails, not redesigns.

## What landed in this pass

| Layer | Guard | File | Failure it converts |
|-------|-------|------|---------------------|
| Compile / CI | **Wiring integrity check** | `src/infra/wiring-check.ts`, `scripts/verify-wiring.ts` | Half-wired tool (in a department array but not a valid tool, dead HITL gate, or missing from the supervisor manifest) → now a **red build**, was a silent "I can't do that" in prod. |
| CI gate | **Full merge gate** | `.github/workflows/ci.yml`, `package.json` (`gate`) | CI ran only `test:unit`; regression + wiring never gated. Now: `lint → verify:wiring → test (unit+regression) → test:smoke`. |
| Boot (runtime) | **Strict boot validation** | `src/infra/boot-validate.ts`, `src/index.ts` | A dead LLM provider / missing DB / missing Telegram transport now **throws at startup** before the office compiles, instead of a silently half-dead bot that fails every turn. |
| Deploy smoke | **Robust smoke** | `scripts/smoke.ts` | `pnpm test:smoke` no longer crashes on missing `.env`; it loads env itself, **SKIPs** cleanly with no live env, and **FAILs** on a fatal misconfig. |

All guards are pure + unit-tested, including failure-path tests that prove each
one actually catches breakage (`tests/unit/infra/wiring-check.test.ts`,
`tests/unit/infra/boot-validate.test.ts`).

### Verified
- `pnpm gate` green (lint + wiring + 1110 tests).
- `pnpm test:smoke` SKIP / PASS / FAIL paths all exit with the correct code.
- `validateBootConfig(process.env)` against the real VM env → 0 errors (won't
  wrongly block a real deploy), 1 accurate warning (no `AGENT_FALLBACK_MODELS`).
- Real office probe (local Postgres + live keys): `17×23 → 391`, and a routed
  read — "list my GitHub repositories" → engineering → `github_read` → real repos
  → valid Telegram HTML. The real supervisor→department→tool path works with the
  new guards in place.

## Previous branch status — PR #91

`cursor/prod-hardening-hitl-gateway-e20c` (PR #91, "clear orphan boot interrupts
without DB row") **could not complete**: it is `CONFLICTING` and its four commits
were already cherry-picked into `main` via PR #92 (merged). `main` is a strict
superset of that branch (it contains `execution-guard.ts` and other files PR #91
lacks). **Recommendation: close PR #91 as superseded** — there is no unique work
to recover.

## Remaining shift-left backlog (not done here)

These are real, but each is either a behaviour change needing eval or needs a live
MTProto session, so they are tracked rather than silently changed:

1. **`--env-file=.env` brittleness across other scripts.** `setup`, `dev`, `eval`,
   `brain:sync`, etc. still hard-fail with "ENOENT: .env not found" when env is
   injected directly (as in the Cursor Cloud VM). `test:smoke` was fixed; the same
   pattern should be applied to the rest (load `.env` only if present).
2. **Prompt-mention gaps (6 warnings from `verify:wiring`).** `search_turicks_brain`
   (research/marketing/sales), `search_knowledge` (sales), `search_personal_rag`
   (jobhunt) are wired into departments but never named in those prompts, so the
   agent may never call them. Closing these edits prompts → must be `pnpm eval`-gated
   (CLAUDE.md rule #16), not patched blind.
3. **Real-path smoke is offline-only.** `scripts/smoke.ts` validates config; the live
   Telegram round-trip (send → reply → HITL approve/reject → `action_log`) still
   requires `scripts/e2e-telegram-qa.ts` with an MTProto session.
4. **Product-surface simplification (P6).** 7 departments is wide for the current
   product. Collapsing to research / operator (engineering+personal) / comms and
   moving multi-step tasks into deterministic workflows remains the next reliability
   lever — deferred so it can be done with eval coverage.
