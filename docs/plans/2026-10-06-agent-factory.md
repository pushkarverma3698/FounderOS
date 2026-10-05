# Agent factory: FounderOS makes and supervises agents

> **Status (2026-10-06):** PROPOSED. Nothing is built. Two founder decisions are needed (§ 10).
> **Depth:** Full. It touches a schedule, a DB schema, and turns that can act on the founder's behalf.
> **Brief:** [AG-023](../antigravity/AG-023-named-routines.md) builds Option 1.

## 1. Answer first

1. **The coding pipeline audit is already done** (10-05, approved:
   [2026-10-05-coding-pipeline-thin-slice.md](2026-10-05-coding-pipeline-thin-slice.md)). A clean system means
   finishing that work, not starting a new audit. #920 took waves 1–2 to `main` on 10-06. Next: clear the founder
   blockers, build wave 3, then get the first verified Telegram → merge.
2. **FounderOS can already make simple agents, but they fail.** `schedule_task` runs a prompt on a schedule as a
   normal turn. Of the 21 ever created, 16 failed (07-13 to 07-21), each on its first attempt, and none has been
   created since 07-21. Option 1 (about 2 days) adds retries, a name and a run history, and lists everything under
   `/agents`.
3. **Agents that need a shell and a repo (like pr-brain) get a folder each**, with `AGENTS.md` and `SKILL.md`
   skills that Claude Code, agy, Codex and Cursor all read (Option 2). That comes after the coding pipeline has one
   verified merge, because a new workspace agent ships as a PR that adds its folder. The coding pipeline is
   therefore the factory.
4. **No table or vector database per agent.** Use one brain table with one namespace per agent. FounderOS can read
   all of them.
5. **No more 1,400-line bash daemons**, but don't rewrite the two we have yet. A third one should run on a shared
   runner (Option 2), and pr-brain and agent-dispatch move onto it one at a time, each behind its existing tests.

## 2. What the founder would see (Option 1)

Illustrative; the exact wording settles in the PR.

```
You:    every weekday at 9, check Oplify's open PRs and tell me which are stuck. Call it pr-watch.
Bot:    🔁 New routine pr-watch?  Weekdays at 09:00, until you stop it.   [✅ Approve] [✖ Reject]

Mon 09:01   🤖 pr-watch
            2 PRs stuck: #41 (4 days, CI red), #44 (no review). Yesterday it was 3.

Tue 09:00   Gemini returns 503. Nothing is posted; it retries at 09:02 and 09:12.
            If all three tries fail: ❌ pr-watch failed 3 times (provider busy, 503). Next run Wed 09:00.

You:    /agents
Bot:    🤖 Your agents
        pr-watch      weekdays 09:00 · last ✅ today 09:01 · next Wed 09:00     [▶ Run now] [■ Stop]
        weekly-where  Mondays 08:30 · last ❌ credits used up (402) · next Mon     [▶ Run now] [■ Stop]
        Background
        PR review (pr-brain): OFF. /review on
        Coding dispatch (agent-dispatch): ON, last report 4 min ago
```

Anything a routine does that acts (send, post, merge) still raises its own approval card, the same as when you type it.

## 3. Your five questions

| Question | Answer |
|---|---|
| Did we already audit the coding pipeline? | Yes, on 10-05. Waves 1–2 reached `main` on 10-06 (#920), and wave 3 (Telegram wiring) has not started. |
| Does each agent get its own folder with current best practice that Claude, agy and Cursor can use? | Workspace agents do (§ 5.4). Routine agents don't need a folder: a routine is a row and a prompt. |
| Does each agent get its own DB table or vector knowledge base? | No. One `brain.brain_memories` table with one `project` namespace per agent, plus a run history keyed by agent name (§ 5.3). |
| Are more scripts like pr-brain a good idea? | No. Each one carries its own loop, kill switch, state files and quota pauses in bash: 3,858 lines today, counting the shared `deploy/lib`. Replace them with definitions plus one runner, once a third workspace agent is actually needed. |
| Use the VPS, scheduler, tools and DB fully? | The scheduler, `scheduled_tasks`, the kernel, the tools and the HITL cards already make a routine runtime. Option 1 makes it reliable. Option 2 adds the VPS workspaces. |

## 4. What exists (measured 2026-10-06)

| Piece | State | Source |
|---|---|---|
| Scheduled prompts | `schedule_task` (approved once, repeats daily, weekdays, weekly or monthly) fires each run as a normal turn on the founder's thread. 21 rows ever: 3 done, 16 failed, 2 canceled. None repeating; last created 07-21. | prod query |
| Why they failed | 11 × Gemini `503 … high demand`, 1 × Gemini `429 … prepayment credits are depleted`, 2 × `402 Provider returned error`, 2 × the 300 s turn timeout. Each failed on its first attempt: the runner defers only for halt and the daily budget (`src/gateway/scheduled-task-run.ts:56-65`, `:195-202`). The in-turn model fallback chain existed from 07-11 and the 503s still came through. | prod query, code |
| Routines share the founder's chat | A run holds `withChatTurnLock(chat_id)` (`src/gateway/kernel-run.ts:48`), so a typed message waits while a routine runs. | code |
| Approvals resume by chat | `resumeKernel` and `restorePendingApproval` find the pending card through `threadIdFor(chat)`. An agent running on its own thread would strand its cards. | code |
| Waiting cards | A typed message is held while a card waits, because a new run on the same thread "would resume (or silently drop) the wrong request" (`src/gateway/turn-gates.ts:28-50`). Scheduled runs skip that check. | code |
| Knowledge | `brain.brain_memories.project` already holds 6 project namespaces (largest: `founderos`, 2,112 rows). | prod query |
| Workspace agents | pr-brain (1,434 lines of bash) and agent-dispatch (1,409), plus the shared `deploy/lib` (1,015). Each has its own loop, kill switch (`~/.claude/<name>.off`) and state files. | `wc -l`, code |
| "What's running?" | `readBackgroundJobs()` (`src/tools/background-jobs.ts:179`) already reports both daemons and the built-in crons. | code |
| VPS | 4 vCPU, 7 GiB RAM, about 4 GiB available. Claude Code 2.1.287 for the `founderos` and `antigravity` users; agy for `antigravity`. No `claude-agent` user, and Codex is not installed. | ssh |

## 5. Design: an agent is a definition, not a script

### 5.1 Two kinds

| | Routine agent | Workspace agent |
|---|---|---|
| What it is | A named prompt on a schedule, run by FounderOS's own kernel and tools | A CLI agent (Claude Code, agy, Codex) in its own folder on the VPS, with a repo and a shell |
| Examples | stuck-PR report, Monday "where are we" digest, weekly deploy check | coding builder and reviewer, test fixer, dependency updater |
| Cost each | one DB row; one kernel turn per run (API spend) | a folder and Unix user, subscription quota, RAM per run |
| How many | dozens, with staggered times | 2 at a time on this VPS (§ 5.5) |
| Defined in | Telegram, approved by a card | git, reviewed as a PR |

The more an agent can do, the more review its definition gets. A routine can only call FounderOS tools, and those
already ask before acting. A workspace agent has a shell, so its instructions and tool list are code.

### 5.2 FounderOS supervises; the agent works

| FounderOS owns | The agent owns |
|---|---|
| The one schedule (the existing every-minute sweep, no cron per agent), the kill switch (`/halt`, Stop per agent), approvals (agents never approve), budgets (daily cap and per-run cap), results and receipts, knowledge | Its instructions, its folder and its current run |

This matches what xAI's Grok Bot and OpenAI's Dots ship in 2026. It also follows xAI's advice to give each bot one
job and not build a catch-all assistant. FounderOS stays the generalist.

| Grok Bot / Dots feature | FounderOS today | Arrives with |
|---|---|---|
| A named agent with one job | No names | Option 1 |
| Routines on a schedule | `schedule_task`; 16 of 21 failed | Option 1 fixes it |
| Asks before acting; messages you for decisions | HITL cards in Telegram | Exists |
| Run history per routine (Grok Bot keeps the last 20) | None | Option 1 (`result`), Option 2 (`agent_runs`) |
| Its own computer | pr-brain and agent-dispatch only, in bash | Option 2 |
| Hands coding to a coding agent | `/task` → agy | Exists; wave 3 makes it verifiable |
| Event triggers (GitHub, Slack, mail) | GitHub labels for dispatch only | Option 3 |

### 5.3 Knowledge: one table, one namespace per agent

1. **Notes:** `brain.brain_memories` with `project = 'agent:<name>'`. They use the same embeddings (nomic-embed-text,
   768 dimensions) and the same search. FounderOS and the founder can search across agents; each agent searches its
   own namespace plus the shared `founderos` facts.
2. **Run results:** the `result` column on `scheduled_tasks` (Option 1), later one `agent_runs` table (Option 2),
   keyed by agent name.
3. **Why not a table per agent:** every agent would need its own migration and backup, and every cross-agent
   question would become a union. **Why not a vector store per agent:** it means a second embedding pipeline per
   agent, for a few hundred rows each.
4. **Hard isolation** (Postgres row-level security per agent) is needed only once an agent reads untrusted input
   while holding DB credentials (Option 3).

### 5.4 Workspace folder (Option 2)

```
agents/<name>/                    in the founderos repo, changed only by PR
  agent.yaml                      the definition FounderOS reads (Zod-validated)
  AGENTS.md                       the instructions
  CLAUDE.md                       one line: @AGENTS.md
  GEMINI.md -> AGENTS.md          symlink, as in the founder's global setup
  .agents/skills/<skill>/SKILL.md
  .claude/skills -> ../.agents/skills
/srv/agents/<name>/               on the VPS, written by deploy
  the files above, plus workspace/ (repo checkout) and runs/<run-id>/ (transcript, evidence, result.json)
```

1. `AGENTS.md` is the cross-tool instruction file, now under the Linux Foundation's Agentic AI Foundation. Codex,
   Cursor and many other tools read it. Gemini CLI's default file is `GEMINI.md`, so the folder links it.
2. Claude Code reads `CLAUDE.md`. Since 2.1.277 it reportedly falls back to `AGENTS.md` when there is no
   `CLAUDE.md`. The one-line `@AGENTS.md` import works on any version, so we don't depend on that fallback.
3. Skills use the shared `SKILL.md` format. Codex and Gemini CLI look in `.agents/skills/`, Claude Code in
   `.claude/skills/`, and Cursor in both, so a symlink covers all four.
4. agy is the exception: it loads skills only from `~/.gemini/config/skills/` (checked 2026-10-04), so its skills
   are installed per Unix user. Whether it reads a project-level `AGENTS.md` or `GEMINI.md` is NOT VERIFIED.
5. `agent.yaml` holds the name, one-line purpose, kind, engine, schedule or trigger, tool allowlist, budget per run
   and per day, repo, Unix user, knowledge namespace and the chat it reports to.

To make a workspace agent, you say it in Telegram and the coding pipeline opens a PR that adds `agents/<name>/`. You
approve the PR card, deploy writes the folder, and the agent appears in `/agents`.

### 5.5 Capacity

1. **Routines** run inside the FounderOS process, one at a time, on the founder's chat lock. At the measured p50 of
   18.6 s per turn (09-28 audit), 10 routines due in the same minute finish in about 3 minutes, and a typed message
   waits behind them. Stagger the times. Past about 10 routines, give them their own threads (Option 2).
2. **Workspace agents:** with 4 vCPU and about 4 GiB free, run at most 2 CLI agents at once. Peak RAM per run is
   NOT VERIFIED; measure it before raising the limit.

## 6. Options, smallest first

| | Option 1: Named routines | Option 2: Agent folders and one runner | Option 3: Agents from Telegram at scale |
|---|---|---|---|
| You get | Routines you name from Telegram that retry, report under their name, see their last 3 results, and show in `/agents` with Run now and Stop | Workspace agents defined in git, one TypeScript runner, own threads, a budget per agent; pr-brain and agent-dispatch migrate one at a time | `/newagent` creates the folder, Unix user and definition from chat; row-level security per agent; event triggers |
| Effort | about 2 days (Antigravity) plus review | about 6–8 days (rough) | about 2–3 weeks (rough) |
| Needs first | the `unfreeze` label | wave 3 and a first verified merge; HITL resume by card (Claude builds it) | Option 2 with 3+ agents in use |
| Freeze (until 11-01) | outside A–D: `unfreeze` | partly A (coding agents) | after 11-01 |
| Brief | [AG-023](../antigravity/AG-023-named-routines.md) | written when chosen | none |

### Option 1: Named routines

1. **Retry:** a run that fails with a provider outage (5xx, a 429 that is not about billing, a network error) is
   queued again at +2 min, then +10 min, for 3 tries in total. Billing errors (402, credits depleted) and the 300 s
   timeout fail at once, with the reason. On the July data, 11 of the 16 failures would have been retried.
2. **Name:** `schedule_task` takes an optional `agent` name (`pr-watch`). Every repeat carries the name, and it heads
   the approval card and every report.
3. **History:** each run stores its result. The next run of the same routine sees its last 3 results (600
   characters each, fenced as data), so it can report what changed.
4. **`/agents`:** lists the named routines (schedule, last result, next run, Run now, Stop) and the two VPS daemons
   from `readBackgroundJobs()`.
5. **Waiting cards:** a routine that comes due while an approval card is waiting is deferred 15 minutes at a time,
   the same check that holds a typed message today (`src/gateway/turn-gates.ts:28-50`). A card older than 2 hours
   is expired, as for typed messages. Without this, a routine that raises a card could start its next run on top
   of its own untapped card.

What Option 1 does not give: own threads (routines share the founder's chat lock), a shell, a tool allowlist per
agent (a routine can call any FounderOS tool; the tools that act still ask), a budget per agent, or event triggers.

### Option 2: Agent folders and one runner

1. An `AgentDefinition` Zod schema and `agents/<name>/` folders in git; deploy syncs them to `/srv/agents/`.
2. HITL resume by card nonce: look up `hitl_approvals.thread_id` from the card instead of deriving the thread from
   the chat. Claude builds this because approvals are security-sensitive. After that, agents run on `agent:<name>`
   threads and stop blocking the founder's chat.
3. One runner in TypeScript. Routines go through the kernel; workspace agents go through the existing CLI launchers
   in `deploy/lib/`. Each run writes an `agent_runs` row (agent, start, end, status, cost, result, evidence path).
4. The first new workspace agent the founder names runs on it. Then pr-brain, then agent-dispatch, each behind its
   existing script tests (5 pr-brain and 9 agent-dispatch files in `tests/unit/scripts/`) and a week in shadow mode.
5. A brain write tool scoped to the agent's own `agent:<name>` namespace.

### Option 3: Agents from Telegram at scale

`/newagent` provisions the folder, Unix user and definition from chat, with row-level security per agent, tool
allowlists, event triggers (GitHub webhooks, mail) and container sandboxes. Consider it only when Option 2 has at
least 3 agents in regular use.

## 7. Strongest argument against

1. **The unit is unproven.** The coding pipeline, the workspace agent that matters most (outcome A), has 0
   verified Telegram → merge runs. Copying an unproven unit copies its failures.
2. **There is no demand signal yet.** Only 21 scheduled prompts exist, and the last was created 07-21. Building a
   factory before one routine is in daily use repeats the pattern the freeze exists to stop (1,112 commits in 5
   months, 40% of them fixes).
3. **The freeze runs until 11-01**, and this work is outside outcomes A–D.
4. **Rule of three:** only two workspace daemons exist, and a runner abstracted from two examples usually fits
   neither.

Option 1 survives these objections. It mostly repairs a feature that already exists, where 16 of 21 tasks failed. It
touches none of the coding pipeline files. And it is the cheapest way to learn whether routines get used at all.
Option 2 waits for evidence: a verified merge and a named third workspace agent.

## 8. What this displaces

1. **Wave 3 (H/I/J)**, which wires the Telegram coding flow and produces the first verified Telegram → merge.
2. **The founder's five blockers**, listed at the end of the PR.

Antigravity can build Option 1 alongside wave 3 because the files don't overlap, with one exception: the
registration line in `src/gateway/telegram.ts`. Whichever PR lands second rebases. Antigravity can only push once
the fine-grained GitHub token is installed.

## 9. Order

1. Today: the founder clears the blockers (about 20 minutes).
2. Wave 3: the first verified Telegram → merge.
3. Option 1 (AG-023): in parallel with step 2 if `unfreeze` is approved now, otherwise from 11-01.
4. Run routines for two weeks. If 3 or more are in use and one needs a shell, name it, and that starts Option 2.
5. Option 3 not before 11-01, and only with 3+ agents in use.

## 10. Decisions needed

1. Unfreeze Option 1 now (`unfreeze` label on the AG-023 PR), or wait until 11-01?
2. Which 2–3 agents do you want first? One line each: what it does and how often. The answer decides whether
   Option 1 is enough.

## 11. NOT VERIFIED

1. Whether agy reads a project-level `AGENTS.md` or `GEMINI.md`. Only its skill folder was checked, on 10-04.
2. Claude Code's `AGENTS.md` fallback on the VPS's 2.1.287. It is reported for 2.1.277 and later but was not
   tried; the `@AGENTS.md` import avoids depending on it.
3. Peak RAM of one CLI agent run on the VPS.
4. Whether today's in-turn fallback chain would have absorbed July's 503s.
5. Effort for Options 2 and 3. Both are rough estimates.
6. What a scheduled run does today when it starts while a card waits. The code comment says one tap would resume or
   drop the wrong request. Option 1 holds the run, so the behaviour is not tested on prod.

## 12. Sources (2026 reporting)

1. AGENTS.md: [agents.md](https://agents.md/);
   [Red Hat Developer, 2026-07-27](https://developers.redhat.com/articles/2026/07/27/standardize-project-context-agentsmd-and-agent-skills).
2. Claude Code reads AGENTS.md from 2.1.277:
   [Thariq on X](https://x.com/trq212/status/2101009392611278961);
   [The Register, 2026-09-18](https://www.theregister.com/ai-and-ml/2026/09/18/anthropic-decides-to-support-openais-markdown-instructions-spec/5297588).
3. Portable skills across Codex and other CLIs:
   [Agent Skills in Codex CLI](https://codex.danielvaughan.com/2026/05/05/agent-skills-open-standard-portable-skills-codex-cli-cross-agent/).
4. Grok Bot: [xAI news](https://x.ai/news); [Vellum breakdown](https://www.vellum.ai/blog/official-grok-bot-breakdown).
5. OpenAI Dots: [TechCrunch, 2026-09-29](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/);
   [VentureBeat](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams).
