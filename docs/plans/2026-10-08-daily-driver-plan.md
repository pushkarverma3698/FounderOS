# Daily-driver plan (2026-10-08)

**Founder ask (2026-10-08):** FounderOS replaces the laptop for daily work, answers with the right context every time, uses the VPS fully as one tool layer under every client, and is ready for developer friends to test. Keep it a simple harness.

**Approval:** the founder approved this plan in chat on 2026-10-08 ("go … dispatch parallel agents … promote everything to main"). That approval is the `unfreeze` authority for the briefs below that need it.

## Where we start (verified 2026-10-08)
- One `/task` ran end to end: #994 → spec → approve → build → PR #995 → review → card → merge (10-07). Prod = main `1a4927e9`.
- Still needs the laptop: promotion beta → main, tasks above the executor limit, fix rounds (sweep-only, sweep reviews off).
- Answers: 72% OK on the 10-07 hand grade, follow-ups 67%. Prod runs Flash at every stage. Gmail/Calendar `invalid_grant` (founder re-auth).
- Tool layer: the VPS hub (`src/mcp/hub-server.ts`) serves brain + Google reads + bridged servers, but none of FounderOS's own tools.
- Coding path: ~3,300 lines of bash across `deploy/agent-dispatch`, `deploy/vps-daemons/pr-brain`, `deploy/job-run`, plus labels as state.

## Goals
1. **Laptop-free coding loop:** /task → PR → review → fix rounds → merge → promote → deploy check, all from Telegram.
2. **Right context, every answer:** working memory, follow-up referents, strongest model that passes the golden set.
3. **One tool layer:** the bot, Claude Code, Antigravity and any MCP client call the same FounderOS tools on the VPS.
4. **Simple harness:** each PR deletes more than it adds where it can; labels and sweep crons go.
5. **Friends can self-host:** a developer brings a VPS, a Telegram bot and a GitHub token and is running in under an hour.

## Tickets
| Brief | Goal | Depth | Wave | Depends on |
|---|---|---|---|---|
| [AG-039](../antigravity/AG-039-one-token-one-repo-list.md) one token, one repo list (direct-run PR 2) | 1, 4 | Full | 1 | none |
| [AG-040](../antigravity/AG-040-job-file-replaces-labels.md) job file replaces labels, fix rounds in-job (direct-run PR 3) | 1, 4 | Full | 2 | AG-039 merged |
| [AG-041](../antigravity/AG-041-promote-from-telegram.md) promote + deploy check from Telegram | 1 | Full | 1 | none |
| [AG-031](../antigravity/AG-031-model-truth-and-strong-model-ab.md) part 2, PR #991 | 2 | Full | 1 | none |
| [AG-032](../antigravity/AG-032-founder-working-memory-block.md) working memory | 2 | Full | 1 | none |
| [AG-033](../antigravity/AG-033-follow-up-referents.md) follow-up referents | 2 | Full | 1 | none (merges after AG-032 if both touch the planner) |
| [AG-042](../antigravity/AG-042-native-tools-in-the-hub.md) FounderOS read tools in the VPS hub | 3 | Full | 1 | none |
| [AG-043](../antigravity/AG-043-self-host-for-developers.md) self-host install for developer friends | 5 | Full | 1 | none |

Out of scope now: AG-038 (single-agent loop) stays gated on the golden set after AG-031/032/033; option B (LangGraph coding graph) is not built.

## Order of merge
Claude (orchestrator) reviews every PR with `pr-adversary`, merges to beta one at a time (beta is strict: each merge makes the rest BEHIND → `gh pr update-branch`), then one promotion per wave, deploy check, and a live MTProto probe per change.
