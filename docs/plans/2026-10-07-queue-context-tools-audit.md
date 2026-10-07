# Audit: BullMQ, LangGraph for the coding pipeline, context handling, a central tool layer — 2026-10-07

**Founder ask (2026-10-07):** should FounderOS add BullMQ and replace the coding pipeline with LangGraph nodes; why does
FounderOS answer like it has no memory, compared with Claude Code; should there be one central layer for tools,
workflows, automations and APIs.

**Status:** findings and recommendations. Nothing built. Evidence was read from `origin/beta` @ `6284f8f4` and from prod
(`/opt/founderos` @ `10e2d9f7`, read-only queries).

## 1. Verdicts

| Question | Verdict |
|---|---|
| Add BullMQ? | **No.** It fixes job loss and retries. The pipeline loses no jobs; it fails on quota, credentials, spec quality and review quality. BullMQ also needs Redis, which FounderOS does not run (`REDIS_URL` is empty on prod). |
| Replace the coding pipeline? | **Yes to moving it out of bash, no to a big-bang LangGraph rewrite now.** Port the state machine from ~4,800 lines of bash + GitHub labels to TypeScript + one Postgres table, piece by piece, after the first v2 task reaches a merged PR. |
| Why it acts dumb | **Context plumbing and model, not orchestration.** Four mechanisms, each with a prod example (§3), confirmed by the chat audit (§4). |
| Central tool layer? | **It already exists** (`UnifiedTool` + `capabilities.ts` + the MCP hub). Don't add a layer. Move the things outside it (the coding daemons, crontab jobs) into it. |

## 2. BullMQ and the coding pipeline

### What runs today
- `deploy/agent-dispatch` (1,532 lines bash) and `deploy/vps-daemons/pr-brain` (1,471 lines bash), plus `deploy/lib/*.sh`
  (~1,770 lines). Cron: dispatcher every 15 min plus a per-minute kick check, pr-brain every 20 min.
- State lives in GitHub labels (`agent:ready → working → review → blocked/failed`) and flag files in `~/.claude/`.
- v2 already moved the pure logic to TypeScript: `scripts/pipeline-spec.ts`, `scripts/pr-evidence.ts`,
  `scripts/pipeline-evidence-card.ts`, called from bash.

### Last 7 days, from `~founderos/.claude/agent-dispatch.log`
- ~550 ticks; about 12 claims; `claims=0` on ~534 ticks. The queue is empty almost all the time.
- 18 overlapping ticks, each caught by the lock file. No lost or duplicated claims.
- Failures that cost work: Antigravity quota walls (~29 lines), `agy` missing from PATH (8), the 403 push token (10-06),
  the scope check rejecting #965 (test file only), the trailing-hyphen slug bug (10-05 audit).

None of those is a queue problem. BullMQ gives durable jobs, retries, delays and concurrency limits. The pipeline needs
none of them more than it already has, and it would add Redis to operate. Repo rule #15 (Postgres for durable state,
quoted in `src/agents/agent-tools/signals.ts`) already settled this for the kernel.

### LangGraph for the pipeline
For: the kernel already runs LangGraph with a Postgres checkpointer and `interrupt()` for approvals, so the spec card
and the merge card would be ordinary interrupts.

Against, for now:
1. An Antigravity build runs up to 40 minutes and CI takes longer. A graph node running inside the bot process dies on
   every deploy, which happens several times a day. The build must run outside the bot and resume the graph later,
   which is what cron + labels already do, minus the types.
2. LangGraph checkpoints are hard to query (ADR-016). `/tasks` needs "which tasks wait on me", which is one SQL query
   against a plain table.
3. v2 switched on 10-06 and has not finished one task end to end yet (#956 failed on the scope check). A rewrite now
   resets the first verified run.

### Recommendation
1. Finish one real `/task` through v2 to a merged PR first. That run is the regression baseline.
2. Then add a `coding_tasks` table (status, repo, issue, PR, engine, attempts, timestamps) and a pure
   `nextAction(task)` function with unit tests. Labels become a mirror for GitHub display.
3. Replace `agent-dispatch` with `scripts/coding-daemon.ts`, one pass at a time (claim, run engine, detect PR,
   release stale claims), keeping `agy-run.sh` / `claude-run.sh` as the process runners. Then the same for pr-brain.
4. Revisit LangGraph only if the daemon grows branches that a graph would make simpler.

Estimate: 4–6 days after step 1, in 4–5 PRs. Each bug class seen so far (slug, `curl -s` dropping a 4xx, env-file greps,
macOS-only test failures) becomes a unit test instead of a bash fix.

## 3. Context: why FounderOS answers like it forgot

### How Claude Code holds context
- Every session loads `CLAUDE.md` files and the memory index (`MEMORY.md`) before the first message, so durable facts
  are always in front of the model.
- One agent loop plans and acts with the whole conversation in view, reads files when it needs them, and has no small
  per-task tool cap.
- When the window fills, it compacts into a summary instead of dropping history.
- It runs on Opus or Sonnet.

### How FounderOS holds context (code + prod)
| | Planner | Worker | Synthesizer |
|---|---|---|---|
| Sees | system prompt, clock, screen log (12 h), up to 20 turns / 16K chars, cleared after a 6-hour silence (`src/kernel/state.ts`) | its own prompt + the envelope only (`src/kernel/worker.ts:4-5`) | step results only |
| Durable memory | none injected; only by planning a tool step | only if a tool call fetches it | none |
| Tool calls | none | 6 per step (`MAX_TOOL_CALLS_PER_STEP`) | none |
| Model, last 7 days | `gemini-3.6-flash` | `gemini-3.6-flash` | `gemini-3.6-flash` |

Average planner input is 4,443 tokens. `WORKER_AGENT_MODEL=openrouter:inclusionai/ling-3.0-flash` is set in `.env`, but
`agents.ai_call_costs` shows every call on Gemini 3.6 Flash, so that setting is not taking effect (NOT VERIFIED why).

### The four mechanisms, each with a prod turn (`agents.conversation_turns`)
1. **No always-on memory.** Nothing like `MEMORY.md` reaches the planner. After 6 hours of silence the conversation is
   gone too. 10-04 16:23 "what did I ask you yesterday?" → "No conversation history … could be found."
2. **Lossy planner → worker handoff.** The worker never sees the chat; the planner must copy everything it needs into
   the envelope, and a Flash model often doesn't. 10-06 17:25 "Do the entire cleanup according to the audit" (the audit
   was the turn before) → "the returned data was not visible in the conversation. No issues or PRs were actually closed."
   10-04 16:54 "what did I just ask you a minute ago?" was sent to a worker, which answered about MRR.
3. **Six tool calls per step.** The same 17:25 cleanup "consumed all 6 allowed tool calls" re-listing three repos.
4. **The judge measures the wrong thing.** 108 turns judged in 14 days, average groundedness 95, relevance 99. It checks
   the reply against step results, not whether FounderOS understood the ask, so "dumb" turns score well and nothing alerts.

### Recommendation (smallest first, failing golden case first for each)
1. **Turn the failing turns above into golden cases** (`src/eval/golden-tasks.ts`), so each fix has a red test. 0.5 d.
2. **Working-memory block for the planner**, built by code every turn, ~3–5K tokens: founder profile, active goals,
   in-flight tasks and PRs (the `/tasks` state), last 10 brain decisions, last session summary. This is FounderOS's
   `MEMORY.md`. 1 d.
3. **Code attaches context to every envelope**: the last 3 turns and earlier step results, fenced as data. The planner
   stops being the only courier. Raise the cap for read-only tools to 15; keep side-effecting tools at 6. 0.5 d.
4. **Stronger planner model**, A/B on the golden set: Claude Sonnet or Gemini Pro against Flash. Volume is small (~1.4M
   input tokens a week across all stages), so cost is low; check current pricing before switching. 1 h + one paid eval.
5. **Judge scores understanding**: give it the previous turns and ask "did the reply do what was asked". 0.5 d.

Strongest argument against this: maybe the planner/worker split itself is the problem, and a single agent loop (as in
Claude Code) would beat any plumbing fix. Steps 1–4 test that cheaply: if Sonnet + working memory + envelope context
still fails the golden cases, the split is the next suspect.

## 4. Production chat and log audit (07-14 → 10-06)

**Source.** 569 turns rebuilt from the `founderos.service` journal (trace seams joined by `turnId`), plus
`agents.conversation_turns` and the warning tally for the same journal. 475 turns were typed or tapped in Telegram; the
rest are HITL resumes and scheduled runs.

**Method.** I graded by hand every founder-typed turn since the v3 kernel went live (09-01 → 10-06, 189 turns), because
that is the code running today. Prompts that code writes for the founder (`/task` → "Dispatch this engineering task…",
"Call the deliver_artifact tool now…", "Draft a tailored application… Call read_cv FIRST") are left out. Turns from
July and August were read for patterns, not graded.

### Score
| | Turns | Share |
|---|---|---|
| Did what was asked | 137 | 72% |
| Infra broken (auth, usage limits, model API, dropped turn) | 12 | 6% |
| Lost context (wrong referent, no memory of an earlier turn) | 11 | 6% |
| Partial (did half, or answered a narrower question) | 10 | 5% |
| Wrong action (misread the ask) | 7 | 4% |
| Made something up (claim, number, promise) | 6 | 3% |
| Planner returned no JSON | 3 | 2% |
| Same question, different answer | 2 | 1% |
| Hit the 6-call cap | 1 | 1% |

72% matches the founder's "60 out of 100" once you weight the turns: the successes are mostly single lookups ("how
many jobs", "list open issues", "remind me at 9"). The failures sit on the turns he cares about: follow-ups and
engineering orchestration.

- **Follow-ups fail twice as often.** A follow-up is a turn that only makes sense with the turn before it. 61 follow-ups
  succeeded 67% of the time; 117 standalone asks (infra failures left out) succeeded 82% of the time.
- **Latency** (turns that finished in line): p50 15 s, p90 55 s, 15 turns over 60 s, max 270 s. October is better
  (p50 10 s, p90 20 s); August was the worst month (p50 35 s, p90 132 s).
- **Oct 4–6 is not better than September** on understanding: 68% vs 74% OK, with 6 of 41 turns losing context.

### What "dumb" looks like, by turn
1. **It forgets what we were just talking about.**
   - 09-15 #361: asked "Is the PR ready to be merged?" right after a PR #676 thread → answered about issue #670.
     #363 "But a PR review was done by you previously?" → it had no record of its own review.
   - 10-04 #525/#526: "What repository are these PRs on?" → said FounderOS twice. They were Oplify PRs. The founder
     had to name the repo (#527).
   - 09-16 #382: "I needed a pdf for it. Remember this from next time." → ran a 4-call log audit (220 s), the task from
     two turns earlier.
   - 09-21 #411: "Create a GitHub issue … README" → replied "I have recorded your preference … PDF format", the answer
     to the earlier PDF ask.
   - 10-06 #561/#562: "Do the entire cleanup according to the audit" → re-ran the audit twice and closed nothing.
2. **It doesn't know the founder or itself.**
   - 09-06 #304: "Give me wife's fresh jobs" → "Your wife's profile details were not explicitly found."
   - 09-07 #312–#314: "What is Tashi's CV background?" asked three times got three answers: context only, "unable to
     find", and the right one from `read_cv`.
   - 09-28 #441: "I'll monitor Issue #762 and keep you posted." Nothing in FounderOS can do that.
3. **It makes things up when the data is thin.**
   - 09-16 #396: "Why hasn't it worked on a branch?" → "actively executing … in its isolated workspace". #400 then showed
     the task had not started.
   - 09-15 #377: "Manual test these PRs as a senior QA" → a QA verdict with no test run behind it.
   - Invented numbers: "95% of candidates" (#297); "11 automated commits in 72 hours" (#522).
   - 07-17 (#23/#24): it accepted a made-up MRR of $42K / 11 clients and wrote an investor update on it.
4. **Same question, different facts.**
   - 08-14, scripted founder run, three passes of the same 24 asks:
     - "How many jobs are in the pipeline?" → Applied 0 and Applied 2 in consecutive answers (#195/#196, #219/#220,
       #244/#245).
     - "What did the job search cost last week?" → $0.00, then "could not be retrieved", then $0.28.
   - Temp 0 does not make answers repeatable while the tool choice and the history change from run to run.
5. **It can't look things up the way Claude Code does.**
   - 09-06 #300: "/jobs shows stale jobs, why?" → "tool limits were reached before inspecting the handler".
   - 09-07 #321: looked for the sweep code in a path that doesn't exist. #322: the founder had to say "fetch from
     turicks brain".
   - 08-0x (#105/#112): could not read its own repo (wrong path).
6. **The planner breaks on its own output format.**
   - 09-16 19:42–19:51 (#392/#394/#397): three "Planner did not return JSON" in 9 minutes, each fixed by "Try again".
7. **Broken plumbing looks like stupidity from the founder's chair.**
   - In the journal:
     - 252 "Active provider DOWN — credential expired": Gmail/Calendar `invalid_grant` since August (#193, #414);
       10-04 #520 "I don't have a tool to read calendar".
     - Claude Code usage limits (#259, #403, #410).
     - 3 Gemini API failures in a row (09-29 #451–#453).
     - 25 bot polling crashes; about 12 service restarts a day, all from deploys (86 stops vs 81 deploy runs, 10-01 → 10-07).
     - 58 stranded-task recovery failures.
   - The goal feature replied as if it worked ("command /goal add …", #544/#546/#564), but `agents.goals` has 0 rows.
8. **Nothing alarms on any of it.** The judge scored 108 turns in 14 days at groundedness 95 / relevance 98. Only 2
   turns scored low. #361, #382, #411 and #525 all passed.

### Why Claude Code, ChatGPT and Antigravity feel smarter
It is not the orchestration framework. Those products differ from FounderOS in five concrete ways, and each lines up
with a failure class above:

| They do | FounderOS does | Failure it causes |
|---|---|---|
| One model holds the whole session and every tool result in one context | Three calls (planner → worker → synthesizer) hand off summaries; the worker never sees the chat; history is cut after 6 h of silence | Lost context (1) |
| Durable memory loaded before the first message (`CLAUDE.md`/`MEMORY.md`, ChatGPT memory) | Memory only if the planner thinks to plan a lookup | Doesn't know founder or self (2) |
| Frontier model at the reasoning step (Claude Code: Opus/Sonnet) | Gemini 3.6 Flash for every stage, forced into a JSON plan | Invents filler, JSON breaks (3, 6) |
| General tools (read, grep, shell) and dozens of calls per task | Narrow tools, 6 calls per step | Can't find out, guesses instead (5) |
| Asks when unsure | The planner must emit a plan; "ask" competes with "act" | Wrong action (4% of turns) |

### Recommendation: what moves 60 → 85
Tasks, order and briefs: [2026-10-07-understanding-plan.md](2026-10-07-understanding-plan.md) (AG-030 → AG-038).
These replace §3's list and keep its order. Each step starts with a failing golden case.
1. **Golden cases from the turns above** (#361, #363, #382, #411, #525, #561, #304, #312, #396, #441, #531). 0.5 d.
2. **Model A/B, today's graph:** planner and worker on Claude Sonnet 5.5 (or Gemini Pro), compared with Flash on the
   golden set. This is the cheapest test of the "is it the model?" question. 1 h + one paid eval.
3. **Working-memory block** for the planner (founder + family profiles, active goals, in-flight tasks/PRs, last 10
   brain decisions, last session summary), plus code-attached recent turns in every envelope. 1.5 d.
4. **Single-agent "conversation" loop for read/think turns:** one strong model, the full conversation, the
   working-memory block, every read tool, and a cap of about 25 calls. This is how Claude Code works.
   - Side-effecting tools stay safe without the plan→worker split: 12 tools in `src/agents/agent-tools/` already call
     `hitlGate()` inline, so the gate lives in the tool, not the graph.
   - Keep code-recorded receipts and check the final reply's action claims against them, as `validateStepResult`
     does today.
   - Full-depth change, 3–5 d. Build it only if steps 2–3 leave the golden cases red.
5. **Remove the plumbing failures that read as stupidity:**
   - Gmail/Calendar re-auth (founder only).
   - Make `/goal add` persist or reply that it failed (#966).
   - Restarts: 86 in 7 days, all clean deploy restarts (81 deploy runs). Turns in flight are not drained (AG-037).
   - Judge gets the previous turns and scores "did it do what was asked" (fold into AG-029).

**Strongest argument against step 4:** the CI invariants and the $0 offline kernel test are built around plan →
dispatch → worker. A free agent loop is harder to keep deterministic. **Answer:** keep determinism where it protects
something (gates, receipts, routing of sends) and give up "the planner must emit typed JSON" for questions. A wrong
JSON plan has never protected the founder from anything.

**Freeze (10-03 → 11-01):** this is kernel work outside outcomes A–D. It serves A (a Telegram task becomes a PR) only
indirectly, so each PR needs the `unfreeze` label: founder decision.

## 5. A central tool layer

What exists:
- `src/tools/` — 91 `UnifiedTool` implementations with one `ToolResult` envelope.
- `src/agents/capabilities.ts` — the single registry of which worker carries which tool; self-knowledge answers are
  generated from it.
- `src/mcp/hub-server.ts` — one MCP server that Claude Code, Codex, Cursor and Antigravity all start; brain, Google
  reads and connected MCP servers. Sending stays in Telegram behind HITL.

What sits outside it:
- The coding pipeline: bash calling `gh`, `agy` and `claude` directly.
- Crontab jobs on the VPS (8 entries: dispatcher, kick, pr-brain, three journeys, watchdog, backup), alongside the
  in-process scheduler.

Recommendation: no new layer. When the pipeline moves to TypeScript (§2), its actions (claim task, run engine, post card,
read evidence) become `UnifiedTool`s in the same registry, so Telegram, the daemon and the MCP hub call the same code.
Move cron jobs into the scheduler registry only when one of them is touched for another reason.

## 6. In-flight work this would displace (#30)
- Coding pipeline v2: first real task (#956) needs one clean run to a merged PR.
- One-brain wave 2: AG-028 (Telegram/daemon feed) and AG-029 (recall + eval). AG-029 overlaps with §4 step 5 (judge); fold the
  judge change into it rather than running both.

## 7. NOT VERIFIED
- Why `WORKER_AGENT_MODEL` does not take effect on prod (cost rows say Gemini 3.6 Flash for workers).
- That a stronger model fixes the golden cases. §4 step 2 measures it.
- Dispatcher log counts are grep counts over 10-01 → 10-07, not a per-issue reconstruction.
- Chat-audit labels come from one grader (me) reading the transcript. Golden cases (§4 step 1) are the way to re-check
  them.
- 2 turns end with no reply and no HITL resume (#360, #378). From the journal I can't tell whether the run crashed or
  timed out.
- Whether `update_context` preferences such as "no staff roles" changed later job screening.
