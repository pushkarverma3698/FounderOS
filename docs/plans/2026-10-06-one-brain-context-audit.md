# One brain: context audit and plan

| | |
|---|---|
| **Branch** | `claude/docs-one-brain-context-audit` (cut from `origin/main` @ `f74e3262`; PR base `beta`) |
| **Depth** | **Full** for every build PR below: it changes what the planner reads on each turn, moves data between machines, can carry secrets, and touches group-chat access. |
| **Moves** | B ("where are we" across every repo and agent) · A (the coding loop knows what Mac Claude and Antigravity already did). Frozen paths need the `unfreeze` label. |
| **Founder ask (2026-10-06)** | "FounderOS should know everything done on mac and within itself … answer everything with the right context when needed … one brain which is a shared brain." |
| **Status** | Proposed. Nothing below is built. |

## The founder moment
On Monday morning he types "what did Claude do on the Mac last night, and where did we leave PR 79?" in Telegram.
FounderOS answers from the Mac session digest, the Antigravity walkthrough and the Telegram thread. Each line
carries its date and origin. When nothing matches, it says "nothing recorded" instead of guessing. Later he opens Claude
on the Mac, and its first context already holds what he asked Telegram since the last session.

## Verdict
There is a brain (`brain.brain_memories`, 2,289 rows, ADR-038), but it isn't shared:

1. **Telegram does not read it for memory questions.** The admin worker's `search_memory` reads the legacy
   `knowledge_entries` table plus episodic events, turns and founder_context
   (`src/tools/memory.ts:65-97`). Only research, marketing and sales can reach `brain_memories`, through
   `search_knowledge` (`src/agents/capabilities.ts:124-136`). Engineering, the worker that answers "what work
   happened", has no memory tool at all. The 166 decisions and bugs that Mac Claude and Antigravity saved through
   MCP never reach an admin answer.
2. **Nothing from the Mac reaches it automatically.** 636 Claude transcripts (228 from the last 7 days), 176
   founderos memory files and 273 Antigravity conversations add up to 0 brain rows. The one script built for this
   (`scripts/ingest-claude-sessions.ts`) is manual, and it writes the laptop's own Postgres, a copy nothing
   reads (`~/Projects/scripts/ai-tools/founderos-brain-mcp.sh:12-15`).
3. **Nothing from Telegram reaches it.** Turns go to `agents.conversation_turns`, which the MCP hub never reads
   (`src/mcp/brain-tools.ts:108`). Mac Claude can't see what was asked in Telegram.
4. **Reads never abstain and carry no provenance.** There is no score threshold anywhere in `src/db` or
   `src/mcp`. The hub prints `Source: unknown` on every agent-written row (`src/mcp/brain-tools.ts:120`) and no
   date at all.

## Measured (prod and Mac, 2026-10-06)

### What the brain holds
| Store | Rows | Note |
|---|---|---|
| `brain_memories` | 2,289 (2,280 ACTIVE, 9 SUPERSEDED, 0 without embedding) | ~2,104 (92%) are `docs/*` chunks from the nightly `brain-sync.yml` |
| … written by agents (`source = ide_mcp`) | 166, from 09-07 to 10-06 | Good quality. 21 have `project = null` and disappear from project-scoped search. 10 duplicate groups (11 extra rows). 1 junk "test decision". No agent, machine or session recorded. |
| … Antigravity session rows | ~8, all from 09-07 | `pnpm session:sync` is manual; its only caller, `self-improve-cron`, was disabled 08-21 (`src/infra/scheduler.ts:15`) |
| … plan chunks older than 30 days | 497 ACTIVE | Recency decay is capped at 30% (`src/db/rag-recency.ts:18`) |
| `conversation_turns` | 20, all in the founder DM (10-04 → 10-06 11:50) | The group `-5319642142` has 11 checkpoints (latest 10-06 13:47) and 0 turn rows |
| `knowledge_entries` / `turicks_brain` | 785 / 1,352 | Two legacy doc stores. `knowledge_entries` is still written nightly; `turicks_brain` has no reader or writer |
| `goals` | 0 | Even though the founder asked for a goal twice on 10-06 (see H1) |
| `personal_rag` | 4 | Stub. No worker reads it |

### What the Mac and VPS hold that the brain doesn't
| Source | Size | In brain |
|---|---|---|
| `~/.claude/projects/*/memory/*.md` | 18 project dirs; founderos 176 files, linkedin-growth-engine 33, Oplify 22 | 0 |
| `~/.claude/projects/*/*.jsonl` (Claude sessions) | 636 files, 1.4 GB, 228 in the last 7 days | 0 |
| `~/.gemini/antigravity/conversation_summaries.db` | 273 conversations, 05-21 → 10-05 | 0 |
| `~/.gemini/antigravity/brain/<id>/` | 82 `implementation_plan.md`, 62 `walkthrough.md`, 56 `task.md` | 0 |
| VPS `/home/founderos/.claude/projects/*` (pr-brain review sessions) | not counted | 0 |
| `~/.claude/screen.jsonl` on the VPS (daemon and command output sent to Telegram) | 12 h window | 0 (read only by the planner, last 12 h) |

### What each model sees per turn
- **Planner:** static prompt, clock line, the screen log (last 12 h, 12 entries, 6,000 chars) and its own
  checkpoint history (20 turns, 16,000 chars, dropped after a 6 h gap) (`src/kernel/planner.ts:330-332`,
  `src/kernel/state.ts:175`). There is no automatic retrieval, and it sees no goals, lessons or brain rows.
- **Workers:** their prompt plus the TaskEnvelope. Retrieval happens only when a worker picks a tool. Comms,
  engineering, personal and jobhunt have no memory tool.
- **Mac Claude via the hub:** `brain_memories` only. It can't read `conversation_turns`, `action_log`,
  `founder_context`, `goals`, the screen log or episodic events.

## Where it hallucinates today (each one seen in prod)
| # | What happens | Evidence | Root cause |
|---|---|---|---|
| H1 | History says a command **ran** when only a "Run this?" card was shown | 10-06 02:36 and 02:58: "my goal this month is 20 applications" → history "Ran /goal add 20 applications …". `goals` has 0 rows. The screen log shows the "Run this?" cards and, later, "No goals yet" | `src/kernel/planner.ts:384-392` writes "Ran /…" before the gateway decides. `src/gateway/command-dispatch.ts:88-104` holds the command in an in-memory map, so a restart loses it |
| H2 | Confident wrong hit, no abstain | Hub `search_memory` "PR 79 verdict" (asked in Telegram today) returned an unrelated Oplify QA decision at 0.857 and the "test decision" row | No threshold. RRF scores are relative, so the top hit always looks strong |
| H3 | Results can't be dated or attributed | MCP rows print `Source: unknown`. Recency reads a date only from a `YYYY-MM-DD` file name (`src/db/rag-recency.ts:26-29`), so agent rows never decay | No provenance fields on write (`src/mcp/brain-write-args.ts:11`) |
| H4 | A tool's page limit reported as the whole answer | 10-06 11:50 "what work was done in FounderOS in the last 2 days" → "20 commits total, all from Oct 6". `origin/main` has 80 commits dated 10-05 IST | `list_commits` fetches `per_page: 20` (`src/tools/github.ts:301-304`) and says nothing about what it left out |
| H5 | The latest turn of every chat is missing from the durable log | DM checkpoints run to 14:12, turn rows stop at 11:50. The group's 10-06 turn has no row | The turn is written when the **next** turn starts (`src/kernel/planner.ts:290-292`) |
| H6 | The Mac's nightly ingest reports success while failing | `brain-auto-ingest.sh` runs `brain:sync` (refuses off the VPS) and `personal:sync`, hides errors with `2>/dev/null \|\| echo skipped`, then prints ✅ | False-green cron; it would not ingest sessions or memory even if it worked |
| H7 | Telegram answers memory questions from a stale store | `search_memory` → `knowledge_entries` ILIKE (`src/db/queries.ts:972`), not the vector brain | Two doc stores, and the wrong one is wired to admin |
| H8 | Mail and calendar answers are unavailable | `invalid_grant` in prod (10-06 session doc) | Google token expired; only the founder can re-auth |

## Where it will hallucinate once more context flows in (design risks)
| # | Risk | Guard, built into the PR that creates the risk |
|---|---|---|
| F1 | Raw transcript text carries tool output (emails, web pages). Ingested verbatim, an injected instruction becomes "memory" that the planner reads as its own | Digests keep founder prompts, final answers, branch, PR links and files. Tool output is never kept. Rendered with a `[recorded data]` tag, as history already uses `[prior turn reply]` |
| F2 | A reversed decision and its reversal both come back undated, and the model picks one | Every rendered row shows date and origin. `supersedes` in metadata; newest first on a tie |
| F3 | Group guests read the founder's Mac sessions or DM turns: allow-listed group members can call every non-HITL tool (`src/gateway/chat-access.ts`) | `metadata.visibility = "founder"` on Mac, Antigravity and DM rows, filtered whenever the run's thread is not the founder DM. Ships **in the same PR** as the capture |
| F4 | A Mac memory file is corrected or deleted, but the brain keeps the old fact | Capture upserts by path + hash and marks rows for missing files `ARCHIVED` |
| F5 | Secrets from a transcript land in a table that guests and five agents can query | Secret scrubber (key, token and `.env` patterns) before anything leaves the Mac, with a unit test on real-shaped samples. A row that trips the scrubber is dropped, not redacted-and-kept |
| F6 | "Yesterday" counted in UTC while the founder means IST | Digest day boundaries use `APP_TIMEZONE`, as recall already does |
| F7 | Capture silently stops (like H6) and the brain goes stale without anyone noticing | `/where` prints "Mac capture: last run N min ago, M rows". Older than 2 h shows ⚠️ |

## Target design
One store, `brain.brain_memories` on the VPS. Every agent writes there, every reader reads there, and every row says
who wrote it, when, from where, and who may see it.

```
Mac  ── launchd every 30 min: brain-capture (digest + scrub, no LLM, no DB) ── ssh ──┐
     ├ ~/.claude/projects/*/memory/*.md          (origin mac-claude, type claude_memory)
     ├ ~/.claude/projects/*/*.jsonl → digest     (origin mac-claude, type session)
     └ ~/.gemini/antigravity/{summaries db, walkthroughs, plans} (origin mac-agy)
VPS  ── scripts/brain-ingest-digests.ts (stdin JSONL → brainIngest, upsert by source_id) ─┐
     ├ conversation_turns, logged at turn end          (origin telegram, per-chat visibility)
     ├ screen.jsonl daily digest                       (origin vps-daemon)
     └ pr-brain session digests                        (origin vps-claude)
                                                       ▼
                                            brain.brain_memories
                     metadata: origin, client, machine, session_id, repo, occurred_at, visibility
                                                       ▼
 Telegram: admin + engineering get search_knowledge; planner gets a "recent activity" block (DM only)
 Mac:      hub search_memory shows date + origin + abstain; SessionStart hook prints "since last session"
```

Rules:
- **No new store.** Telegram turns stay in `conversation_turns` for exact recall; the brain gets digests.
- **Capture is deterministic**: no LLM, $0, re-runnable, idempotent on `source_id`.
- **The Mac never holds DB credentials.** It pipes JSONL over the existing SSH trust to a VPS script.
- **Every reader renders** `date · origin · project` per row and prints `No strong match` under the
  calibrated threshold.

## Phased PRs (each is one Antigravity brief)
| Order | Brief | Fixes | Size |
|---|---|---|---|
| 1 | [AG-024](../antigravity/AG-024-honest-command-history-and-page-limits.md): history says "Offered", not "Ran"; tools say when they cut a list | H1, H4 | S |
| 2 | [AG-025](../antigravity/AG-025-telegram-reads-the-shared-brain.md): admin and engineering read `brain_memories`; every reader shows date, origin and abstain | H2, H3 (read side), H7 | M |
| 3 | [AG-026](../antigravity/AG-026-provenance-on-every-brain-write.md): writes carry origin, client, machine, occurred_at and visibility; recency reads them | H3 (write side), F2, F3 groundwork | S |
| 4 | [AG-027](../antigravity/AG-027-mac-capture-into-the-vps-brain.md): Mac memory, Claude sessions and Antigravity reach the VPS brain every 30 min; replaces the false-green cron | Mac sources at 0 rows, H6, F1, F3–F7 | L |
| 5 | [AG-028](../antigravity/AG-028-telegram-and-daemons-into-the-brain.md): turns logged at turn end; daily Telegram, daemon and pr-brain digests; hub reads Telegram turns | H5, group and pr-brain sessions at 0 rows, Mac Claude blind to Telegram | M |
| 6 | [AG-029](../antigravity/AG-029-recall-surfaces-and-cross-source-eval.md): planner "recent activity" block, Mac SessionStart digest, cross-source golden eval | No automatic retrieval; the mechanism for all of the above | M |

AG-024 and AG-025 stand alone and pay off on their own. AG-027 depends on AG-026 (provenance fields) and must
ship F3's visibility filter in the same PR. AG-029 depends on AG-027 and AG-028 (it needs rows to recall).

One-off hygiene, run by Claude on the founder's yes (prod data, so Full; not a brief):
- delete the "test decision" row;
- merge the 11 duplicate rows;
- tag the 21 null-project rows from their content;
- mark shipped plans `**Status:** Superseded` in their files so the nightly sync stops serving them.

## The mechanism (#27)
`src/eval/retrieval-golden.ts` gains cross-source questions with known answers, such as "what did I ask about PR
79 on 10-06" (Telegram), "what did Antigravity do on conversation X" (mac-agy) and "what did Claude decide about the
screen log" (mac-claude). It also gains abstain cases: questions with no answer must return `No strong match`.
`pnpm eval:retrieval` runs them, and the AG-029 PR adds them to the nightly `brain-sync.yml` after the sync, so a
dead capture shows up as a red run, not a quiet gap.

## Strongest argument against
**Per-turn context grows, and the planner is already slow (p50 18.6 s, 09-28 audit).** More context can also
mean more confident wrong answers if retrieval is noisy. Answer: AG-029's block is SQL only (no embedding call),
DM only, capped at 12 lines and 2,500 chars, and the abstain threshold ships first (AG-025). If the golden eval
shows the block hurts, it stays off; capture and the tool path still give the full benefit on demand.

**Second argument: this is outside the freeze.** Outcome B is "where are we, across all repos", built with zero
LLM. Capture and digests are zero-LLM and feed `/where`. But AG-025 and AG-029 change the planner and worker
tool sets, so the founder decides whether B covers them now or they wait for 11-01.

## Displaced work (#30)
- Founder screen context P2–P5 (`docs/plans/2026-10-06-founder-screen-context.md`): AG-028's screen digest
  replaces P3's "durable screen history".
- Agent factory plan, PR #923 (docs only), and AG-023 routines: unaffected, and they still need `unfreeze`.
- Pipeline wave 3 rollout (flag, `/login`, `ORACLE_ALLOWED_HOSTS`): unaffected; it is founder-gated.

## NOT VERIFIED
- The laptop `.env` `DATABASE_URL` points at a local Postgres: reading `.env` is blocked for agents. The
  conclusion rests on the comment in `founderos-brain-mcp.sh:12-15` and the background trace.
- VPS pr-brain session count under `/home/founderos/.claude/projects`: not counted.
- 10-04 16:54 "what did I just ask you a minute ago?" was answered with an MRR search the turn log does not
  contain. Either an unlogged turn (H5) or a wrong answer; not traced.
- The abstain threshold value: it must be calibrated by the AG-025 eval, not picked here.
- No live Telegram probe was run for this audit (paid). Every prod claim above comes from SQL and logs read on 10-06.
