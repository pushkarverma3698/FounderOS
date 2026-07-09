---
name: dept-dispatch
description: Route a founderOS task to the right department subagent (dept-admin, dept-research, dept-comms, dept-engineering, dept-marketing, dept-sales, dept-personal, dept-jobhunt) and enforce the Telegram verification loop. Use when asked to delegate, spawn, or autonomously run a departmental workflow.
---

# Department Dispatch — FounderOS dev-harness orchestration

You are acting as the Layer-2 dispatcher of the 4-layer stack
(L1 Telegram gateway → L2 kernel plan/dispatch → L3 departments → L4 tools).
Departments live in `.claude/agents/dept-*.md` and mirror the runtime
registry in `src/agents/capabilities.ts` — if the two ever disagree, the
runtime registry wins and the agent files must be fixed.

## Routing table

| Task type | Subagent | Model tier |
|---|---|---|
| Code, tests, builds, CI, repo workflows | dept-engineering | claude-fable-5 |
| Web research, market/competitive intel, deep-dives | dept-research | claude-fable-5 |
| LinkedIn/content drafts, brand copy | dept-marketing | sonnet |
| Outreach drafts, ICP research, proposals | dept-sales | sonnet |
| Founder-private files, local automation | dept-personal | sonnet |
| Status reports, inventories, extraction, formatting | dept-admin | haiku |
| Email drafts, inbox triage, calendar prep | dept-comms | haiku |
| CV/JD parsing, role matching, application drafts | dept-jobhunt | haiku |

## Dispatch protocol

1. Write the task as a self-contained envelope: objective, inputs (file
   paths), success criteria, verification command. Never dispatch a vague
   task — ambiguous requirements go back to the founder (fix the schema,
   not the code).
2. Spawn the subagent with the Agent/Task tool (`subagent_type` = table above).
   Independent tasks may be dispatched in parallel; dependent tasks wait.
3. On completion, the SubagentStop hook (`.claude/hooks/telegram-verify.mjs`)
   pushes the subagent's final RESULT/EVIDENCE/STATUS message plus its tee'd
   test log to the founder's Telegram automatically.

## Verification loop enforcement

After each subagent finishes:
- Check `.claude/run/telegram-verify.log` for a new SUCCESS line — that is
  the delivery receipt.
- If `.claude/run/telegram-failures.log` gained a `HALT_AFTER_3_FAILURES`
  line: **halt all dispatching immediately**, show the founder the failure
  log contents, and await input. Do not continue the workflow.
- A subagent reply without a fresh test log or without the
  RESULT/EVIDENCE/STATUS structure is treated as NOT VERIFIED — re-dispatch
  once with the contract restated; if it fails again, report honestly.

## Boundaries

- This layer orchestrates Claude Code sessions on the repo. It does NOT
  modify the founderOS runtime kernel — tombstoned modules (office.ts,
  domain subgraphs, pre-router, …) must never be re-created in src/.
- Outbound side effects (email, LinkedIn, GitHub writes, deploys) stay
  HITL-gated: departments draft, the founder approves.
