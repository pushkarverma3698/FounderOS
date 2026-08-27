# FounderOS Proof Scoreboard

_Generated 2026-08-27T10:40:09.076Z · commit `27a40eb` · regenerate with `pnpm proof:scoreboard`_

## Deterministic test suite (offline, $0)

✅ 3611 tests / 329 files — all green

## Kernel guarantees (each one is an executable scenario, not a claim)

- A greeting costs exactly 1 LLM call (direct-reply path) — `kernel-e2e: hello-world`
- Routing is a validated typed Plan, produced once — `kernel-e2e: route override / garbage planner`
- Every tool execution emits a code-recorded receipt; unproven action claims are rejected — `kernel-e2e: fabricated action`
- Tool budgets TERMINATE loops with a typed failure; the thread is never wiped — `kernel-e2e: loop scenario (audit Run-D)`
- HITL reject = typed hitl_rejected, side effect provably not executed — `kernel-e2e: HITL reject`
- Identical inputs → byte-identical plans — `kernel-e2e: determinism`

## Architecture-debt ratchet (CI-enforced: may only shrink)

| rule | open violations |
|---|---|
| gateway-imports | 0 ✅ |
| kernel-purity | 0 ✅ |
| fail-open-catch | 11 |
| loc-budget | 6 |
| regex-routing | 0 ✅ |
| orphan-subsystem | 0 ✅ |
