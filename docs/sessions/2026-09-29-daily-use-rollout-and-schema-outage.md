# 2026-09-29 — Daily-use fixes rolled to prod; a tool schema took down the engineering worker

## What we did
- Audited 90 production chat turns (09-15 → 09-28), every tool call, all 10 Antigravity tasks and pr-brain's token use. Findings are in the brain (`project: founderos`).
- Shipped the fixes through beta → main:
  - #765 reverted the fake "Jev AI" router
  - #766 made pr-brain carry a verdict forward over its own commits, and agent-dispatch wait out the Antigravity quota
  - #767 answers the family group, sends `/draft` CVs to the chat that asked, lets the code own the v3 self-description, and adds task status/re-queue tools
- #769 merged `main` into `beta`: the #761 squash had left one conflict in `scripts/seed-founder-context.ts`, and the resolved tree equals beta.
- Promoted with #764 and deployed (`189e318`, 09:24 UTC).

## What we fixed
- **Engineering-worker outage, found by the first live probe after deploy.** #767's `antigravity_task_status` / `requeue_antigravity_task` declared `issue: z.number().int().positive()`. Zod emits `exclusiveMinimum`, which `@langchain/google-genai` passes through, and Gemini rejects the whole request with 400. Every engineering turn failed. All 5063 unit tests were green, because scripted models never see a schema.
- The fix (#771 → #772, deployed `1e79703`, 09:44 UTC) changes it to `.min(1)` and adds a guard, `tests/unit/agents/gemini-tool-schema.test.ts`. The guard converts every worker tool the way google-genai does and allows only Gemini `Schema` keywords, plus `not`, which prod evidence shows Gemini accepts.

## Why
A new tool can pass every offline test and still break a whole worker in prod. The guard moves that failure into CI. The live MTProto probe is what caught it: without it, #767 would have been reported as done.

## Metrics
Live probes run through Telegram as the founder, after the #772 deploy:

| Prompt | Result |
|---|---|
| "where are we on issue #762?" | `antigravity_task_status` answered in 12s, with a receipt |
| "In two sentences, how is FounderOS built?" | Described the v3 pipeline correctly in 12s. Before the fix: v2 |
| "status" | Reached the planner. The canned "System status: operational" is gone |
| `/draft 1` | Summary, then the CV PDF, then the cover letter. 3 replies, 25s, no approval card |

Other checks:
- Deploy seed: "Rewrote 3 system key(s)" and "Removed 4 retired June seed value(s)".
- Bot `can_read_all_group_messages=true`, and it is a member of the family group.
- Both group ids are set in prod `.env`. The daemons on the VPS match the repo by md5.

## Outstanding
- `current_focus` and `active_projects` in prod `founder_context` still hold the June "Phase D-Bis" text. The seed only fills keys, and the founder has to state his current focus.
- The family group has had no live message since the deploy.
- Gmail and Calendar: the credential has been expired since at least 09-16.
- The status tool reports #762 as "PR #763 merged", even though #765 reverted it. It does not look for reverts.
