---
description: Plan → approve → implement → gate → contract-review → PROD-READY verify a feature
argument-hint: <feature description>
---

Ship a change to FounderOS end to end. Feature: **$ARGUMENTS**

Follow this workflow exactly. Do not skip the STOP.

## 1. Read context
- Read `CLAUDE.md`, `agent-rules.md`, and the specific files the feature touches.
- Restate the goal in one line and list concrete, verifiable success criteria
  (what real path must work, which `action_log`/DB effect proves it).

## 2. Plan, then STOP
- Produce a short numbered plan: files to change, contracts/schemas affected, the
  failing test you'll write first (bug fixes MUST start with a failing test), and the
  live path you'll exercise to prove it.
- **STOP and wait for my explicit approval. Do not touch code until I approve.**

## 3. Implement (only the approved plan)
- Surgical changes only — every line traces to the plan; no drive-by refactors, no TODOs.
- Honor the invariants: `.js` import suffix, `contracts ← kernel ← gateway`, Zod at
  boundaries, provider indirection (`src/infra/providers/`), HITL ordering, immutable
  `KernelState`, loud `FailureReport`s, ≤400 lines/file.

## 4. Gate (real commands — do not substitute placeholders)
```bash
pnpm gate    # lint (tsc --noEmit) + build + verify:wiring + verify:arch + test
```
Paste the output. If it fails, fix and re-run until green. Do NOT run the paid gates
(`pnpm eval`, `pnpm qa:telegram`) unless I explicitly ask — this is a milestone gate.

## 5. Contract review
- Invoke the `contract-reviewer` agent on the changed files.
- If VERDICT is **FAIL**: apply the suggested fixes, re-run `pnpm gate` (step 4), and
  re-invoke `contract-reviewer`. Loop until VERDICT is **PASS**.

## 6. PROD-READY verification (evidence over assertion — rule #24)
- "Done" is NOT "tests pass." Exercise the REAL path this session and show output:
  drive gateway → kernel → tool → reply and confirm the expected effect
  (e.g. the `action_log`/DB row, the receipts block, the actual reply).
- If the path cannot be exercised here, say **NOT VERIFIED — <reason>** and stop short
  of claiming success. Never imply verification that didn't happen.

## 7. Summarize (≤10 bullets)
- What changed (files), why, contracts touched, gate result, contract-reviewer verdict,
  and the live-path evidence (or the explicit NOT VERIFIED reason).
- Reminder: never commit to `main`; flow is work branch → PR to `beta` → `main`.
