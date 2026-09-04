# FounderOS — Claude Instructions (v3)

## Precedence

```text
1. Founder instruction in chat                  ← always wins
2. CI fitness rules (verify-architecture.ts)    ← the only BINDING layer
3. docs/antigravity/STANDARDS.md                ← how code is written
4. CLAUDE.md / AGENTS.md / GEMINI.md            ← role-specific operating instructions
5. Everything else                              ← reference
```

A rule which is not enforced by layer 2 is a convention, and a rule that is enforced cannot be satisfied by argument.

## What This Is
FounderOS is a **deterministic agent kernel** with a Telegram gateway — an
own-brand orchestration product (vs OpenClaw/Hermes-class chat loops) that
runs Turicks operations and generates its own client-facing proof.

**v3 Stack:** Node 22 + TypeScript strict + LangGraph StateGraph (no prebuilt
supervisor) + grammy + drizzle/Postgres + injected models (paid Gemini Flash,
temp 0).

## Architecture (v3 — contract-first, one orchestration path)

```
message → plan (LLM #1: PlannerDecision — direct reply OR typed Plan)
        → dispatch (PURE CODE supervisor: plan[cursor] → TaskEnvelope)
        → agent ⇄ tools (worker: isolated envelope-only context, capped tools,
                         code-recorded ToolReceipts, HITL interrupt() inside gated tools)
        → collect (pure: StepResult validated against OUTPUT_CONTRACTS)
        → … cursor++ … → synthesize (LLM: results only) → reply + receipts block
```

- **Contracts are the architecture**: `src/kernel/contracts.ts` (TaskEnvelope,
  Plan, StepResult, FailureReport, ToolReceipt). Every boundary is Zod-validated;
  a mismatch is a terminal, typed failure — never a retry-and-hope.
- **Zero-hallucination is a mechanism**: action claims require successful
  receipts (`validateStepResult`); the synthesizer sees only validated results.
- **Failures name the real component**: FailureReport = stage + component +
  evidence + retryable. The founder always sees them; threads are NEVER wiped
  (only `/reset` wipes, by explicit founder command).
- **The kernel is a library**: models/tools/checkpointer injected
  (`src/gateway/kernel-boot.ts` is the ONLY composition root). The full graph
  runs offline in CI at $0 (`tests/unit/kernel/kernel-e2e.test.ts`).

## Anti-slop invariants (CI-enforced — scripts/verify-architecture.ts)
1. **Tombstones**: killed modules (office-run, execution-guard, pre-router,
   fast-paths, office.ts, domain subgraphs…) FAIL CI if re-created.
2. **Ratchet**: architecture debt (`governance/architecture-baseline.json`)
   may only shrink. Current: regex-routing 0, gateway-imports 0, kernel-purity 0.
3. **Import direction**: contracts ← kernel ← gateway; kernel may import only
   kernel/core/db/infra/tools.
4. **LOC budget**: no src file over 400 lines.
5. **Fail-open catches** need an `// allow-failopen: <reason>` tag.

## Non-negotiable rules (carried from v2, all still enforced)
- **HITL**: DB row BEFORE interrupt() (`src/infra/hitl.ts`); side effects only
  after approval; idempotency key check before every external send; audit row
  only on real success. The ordering is pinned by each side-effecting tool in
  `src/agents/agent-tools/`, which calls `hitlGate()` inline — there is no single
  adapter, and `HITL_GATED_TOOLS` is a declaration for rendering, not a gate.
- **Determinism**: temp 0; routing/parsing/guards are pure unit-tested
  functions, never prompt instructions; CI runs the golden set twice —
  plans must be identical.
- **Evidence over assertion (rule #24)**: "done" = the verification command run
  fresh in the same session with output shown. Unit tests are necessary, not
  sufficient — exercise the real path (gateway → kernel → tool → reply →
  action_log row) before claiming anything works. Unverifiable ⇒ say
  "NOT VERIFIED — reason".
- **Fix the schema, not the code**: if a task fails on ambiguous requirements,
  the planner asks for the missing field; never guess data.
- **Bug fixes start with a failing test** (PR template section is mandatory).
- **Deep-ideate, then self-critique from multiple angles (rule #25)**: before acting
  on any non-trivial task, generate real alternatives and argue against your own
  first answer. Three checks are mandatory, in this order:
  1. **Does it already exist?** Grep before you build. (2026-07-29: a recurrence
     module was written from scratch while `nextRecurrence` already sat in
     `src/core/time.ts` — and the existing one was *better*, with real IANA
     timezone handling instead of a fixed offset.)
  2. **What is the binding constraint?** Optimising a downstream variable while an
     upstream one is unverified is the most expensive mistake available. Name the
     constraint before choosing the work.
  3. **What would make this wrong?** State the strongest counter-argument to your
     own plan and answer it, or adopt it.
  Recommend one option with reasons; never present an unranked survey. If a
  conclusion rests on an assumption, verify the assumption or label it unverified.
- **Build for the OUTCOME, not the instruction (rule #26 — founder directive,
  2026-08-01)**: the general form of this rule — the three questions, and the
  2026-07-31 screener that produced zero applications — lives in the global
  `~/.claude/CLAUDE.md` § "Outcome-Driven, Not Instruction-Driven" and is not
  restated here. What is FounderOS-specific:
  - Every deliverable must end in something the founder can ACT ON — a ranked
    shortlist, a draft, a decision, a number that changes a choice. A log of what
    happened is not an outcome. If ignoring the output costs nothing and emits no
    signal, the design is wrong, however many tests pass.
  - Anything shown to the founder must be legible to someone who has never read
    the code. An internal label nobody defined ("Sponsor", "partially overlaps",
    "not checked") is not information. Print every reason, in bullets, with its
    own result — and split the Telegram message rather than hide a row.
  - Never discard collected data because it is currently useless. A senior role
    we will not apply to is still evidence about the market and about our own
    filters; a filtered-out row and an empty market are indistinguishable from
    outside, and that ambiguity has already cost this pipeline weeks. Reject
    inside the pipeline where the reason is stored and shown, never before it.
  - The second failure behind this rule is FounderOS-local: the first real jobhunt
    brief was unreadable because it displayed a PASSING check as the reason a role
    needed attention (2026-08-01).
- **Episodic memory is a file, not a hope**: any session that completes or merges non-trivial work
  writes `docs/sessions/YYYY-MM-DD-<topic>.md`, using `docs/sessions/TEMPLATE.md`'s sections (What we
  did / What we fixed / Why / Metrics / Outstanding), before the session ends. This is what "record
  significant decisions" actually means — a vague instruction with no destination doesn't get
  followed twice. The write lands under `docs/`, so it triggers the Automated Brain Sync rule below
  the same as any other doc change — `pnpm brain:sync` picks it up as an `entry_type: "session"` row,
  retrievable by every future session through `search_knowledge`/`search_turicks_brain`.
- **Zero paid calls in the dev loop** (⚠️ NON-NEGOTIABLE). This rule lives here, not in the global
  `~/.claude/CLAUDE.md`, because every command it names exists only in this repo — carrying it
  globally billed ~475 tokens to every session in every project for a rule that could not apply.

  | Zone | What runs | Allowed cost |
  |---|---|---|
  | Dev loop (write → test → fix) | `pnpm test` (scripted models) + `nomic-embed-text` dedup | **$0** |
  | Integration check (pre-PR) | free OpenRouter model | **$0** |
  | Live verification (PR-ready only) | real Gemini / MTProto QA | once per PR |

  1. A unit or integration test that makes a real LLM call is a **bug**. Tests use mocks, always.
  2. `scripts/probe-*.ts` and `scripts/e2e-telegram-qa.ts` spend Gemini tokens — never run them
     iteratively. Write a failing unit test, fix it, then run the probe ONCE to confirm.
  3. While iterating set `AGENT_MODEL=openrouter:google/gemini-2.5-flash-preview-05-20:free`
     (fallback `openrouter:deepseek/deepseek-r1:free`). Never a `google-genai:*` model in the loop.
  4. `pnpm eval` is a milestone gate, not a debugging tool — once per feature, not once per attempt.
     `pnpm qa:telegram` runs exactly once: tests green, lint clean, PR about to go up.
  5. If a bug needs a live call to reproduce it, capture it in a unit test first; the live call only
     confirms the fix.

## Rules binding on Claude itself (2026-08-06, derived from measured failures)

These come from an audit of ten defects across AG-001…AG-006. Each one names the incident that
produced it. Every rule states **what enforces it** — a rule with no mechanism is labelled
unenforced, and is expected to decay.

- **#27 — A rule with no mechanism decays; say which layer holds it.** Over one month the
  CI-enforced rules in `verify-architecture.ts` drifted **zero** times. Over one day, markdown rules
  drifted **three** times. When proposing any rule, state whether it is enforced by CI, by a script,
  or by nothing but goodwill — and prefer converting it rather than restating it louder. *More
  instruction is not the lever; the asymmetry between layer 2 and layer 4 is.*
  **Enforced by:** nothing. This is the rule that says so out loud.

- **#28 — Founder approval authorizes work; it does not verify it.** An approved plan can still be
  technically wrong, and shipping it is my failure, not the founder's. *(2026-08-06: the founder
  approved three M0a ranking fixes. Fix #1 — "make `scripts/` reachability roots" — was wrong; it
  would have erased a deliberate, documented distinction in `findOrphanSubsystems` and silently
  hidden `src/outreach` and `src/workflows`, the two genuinely dead subsystems. Root-cause
  investigation caught it after approval.)* If I find an approved plan is wrong, I say so before
  building it, then build the corrected version.
  **Enforced by:** nothing. Judgement only.

- **#29 — Review is mine and is not delegable.** A reviewer subagent is an input, never a verdict;
  every causal claim it makes gets verified against evidence before I repeat it to the founder.
  *(2026-08-06: the review subagent asserted AG-005 changed the count AG-004 was told to pin. False
  — AG-005 changed zero workflow references; the 4→7 rise came from my own commit `42a2cbb`. It also
  produced a plausible-but-wrong hypothesis for the AG-004 revert.)*
  **Enforced by:** nothing. Judgement only.

- **#30 — Name the displacement before accepting a redirect.** When a request would displace
  committed in-flight work, state what it displaces and what the delay costs, then do it. The
  founder is entitled to redirect; he is not entitled to do it *invisibly*, because the frozen plan
  lists "design loop never ships — 8 passes, 0 files" as a **realized, critical** risk. A process
  document written instead of a shipped milestone is that risk recurring.
  **Enforced by:** nothing. This is the rule the founder asked me to hold him to.

- **#31 — Status relayed through a human is still unverified.** "It's done" from the founder is a
  report of what an executor claimed, not an observation of the tree. Run `agy-guard`, commit, then
  read. *(2026-08-06: reviewed AG-004 at 20:27 on a relayed "it's done"; the still-live conversation
  reverted the tree at 20:36 and was still writing at 20:39.)*
  **Enforced by:** `~/Projects/scripts/ai-tools/agy-guard` (exit 1 while a conversation is live).

- **#32 — The brief is the defect surface.** Six of ten defects were mine, in the brief, not
  Antigravity's, in the code. Pre-dispatch brief review is worth more than any additional
  instruction to the executor. Checklist: `docs/antigravity/README.md` § "Before you dispatch".
  **Enforced by:** nothing yet. Candidate for a fitness rule once the failure modes are stable.

- **#33 — Never dismiss or reject claims from other AIs out of hand; deep-research and accept valid feedback.**
  Claims, critique, or findings from other AIs (subagents, peer models, automated reviewers, or external AI agents) must never be rejected or dismissed out of hand. Perform thorough, deep research and empirical verification against codebase evidence before reaching any conclusion. If the claim or feedback proves valid upon investigation, accept and integrate it fully without defensive bias.
  **Enforced by:** Judgement & empirical verification loop.

## File map
```
src/kernel/            — contracts, signals, state, planner, supervisor (pure),
                         worker, synthesizer, graph, verify, index
src/gateway/kernel-boot.ts — composition root (models+tools+checkpointer → kernel)
src/gateway/kernel-run.ts  — run loop: lock → gates → invoke → HITL card/reply
src/gateway/telegram.ts    — grammy transport; commands.ts — 7 essential commands
src/agents/            — worker prompts (prompts/, system-prompts.ts),
                         agent-tools/ (LangChain tool wrappers), capabilities.ts,
                         model.ts (status-class error taxonomy)
src/tools/             — UnifiedTool implementations (ToolResult envelope)
src/infra/             — hitl, checkpointer (PostgresSaver), budget, daily-budget,
                         trace, scheduler (maintenance only), health
src/db/                — schema (20 tables; saved_workflows = reusable-script
                         catalog, run_count = "most used"; reminders = zero-LLM
                         pure-ping queue, distinct from scheduled_tasks) + queries;
                         src/eval/ — golden tasks,
                         runner, scoring, kernel-invoker; src/proof/ — proof renderers
src/mcp/               — MCP server (read-only external surface)
video-factory/         — client social-video engine (standalone npm dir, NOT in
                         the pnpm workspace): brands/ registry, projects/,
                         scripts/produce.mjs (receipt-checkpointed executor);
                         kernel side = src/tools/video-{brand,brief,shotlist,
                         models,compose,production,title-card}.ts (pure, $0) —
                         see docs/VIDEO-FACTORY.md + docs/VIDEO-PIPELINE-AUDIT.md
```

## Commands
```bash
pnpm dev / build / start        # run
pnpm test                       # deterministic suite ($0, scripted models)
pnpm lint && pnpm verify:arch   # types + anti-slop gates
pnpm gate                       # full merge gate (lint+build+wiring+arch+test)
pnpm eval                       # live golden-set eval (milestone gate, paid)
pnpm qa:telegram                # 22-task MTProto founder-simulation (production acceptance)
pnpm proof:scoreboard           # regenerate docs/PROOF.md from a fresh run
pnpm proof:costs                # docs/COSTS.md from ai_call_costs
pnpm proof:case-study <thread>  # anonymized case study from a checkpoint
```

## Model policy
**The model chain is deliberately NOT listed here.** `scripts/apply-prod-env-overrides.sh`
(`AGENT_MODEL` / `AGENT_FALLBACK_MODELS`) is the single source — read it. Mirroring the list into
markdown is exactly how prod ran a fully-dead OpenRouter fallback tail for weeks: the doc was
updated, the script never was, and nothing compared them.

Shape (stable; the slugs are not): `AGENT_MODEL` = direct paid Gemini — needs the
`GOOGLE_GENERATIVE_AI_API_KEY` GitHub secret or prod 401s. `AGENT_FALLBACK_MODELS` = same-key paid
Gemini first, FREE OpenRouter last (founder directive: **no paid OpenRouter fallback, ever**).

Temperature 0; `WORKER_AGENT_MODEL` splits planner from workers. Budget caps enforced
(`BUDGET_DAILY_USD`, `RUN_BUDGET_USD`). Provider errors classify by HTTP status class
(`httpStatusOf`/`is503Error`/`isModelFallbackError` in `src/agents/model.ts`): 5xx/429/transport →
retriable; 404 → model fallback; 401/403 → fail loud.

## Prod VPS access (full root — for fixing prod directly)
Claude Code has **full unattended root control of the production VPS** via its
Bash tool. Use it to diagnose and fix prod (logs, service restarts, DB/containers,
configs, OS updates).
- **Reach it:** `ssh founderos-vps '<cmd>'` — alias resolves to
  `founderos@95.217.162.12` (host `founder-os`) with key `~/.ssh/founderos_deploy`.
  `root@` direct login is denied; the `founderos` user is the entry point.
- **Root:** passwordless sudo is configured (`/etc/sudoers.d/founderos-nopasswd`);
  prefix privileged commands with `sudo -n …`.
- **Layout:** project at `/opt/founderos`; `founderos.service` (systemd) runs the
  bot; `founderos-ollama` + `founderos-postgres` run under docker.
- **Prereq if unavailable:** the SSH alias + key are per-machine. If
  `ssh founderos-vps` fails from a fresh machine/account, the operator must add the
  `founderos-vps` block to `~/.ssh/config` (see `deploy/ssh-config.founderos-vps.example`
  on branch `claude/mcp-vps-ssh-bridge`) and hold the `founderos_deploy` key.
- **This is prod:** it's the live box, no second gate — verify before destructive
  commands; prefer non-disruptive reads first (rule #24 evidence discipline applies).

## End-of-session handoff (ALWAYS)
At the end of every session — and whenever wrapping up a substantive piece of
work — Claude MUST close with an **"Outstanding from your end"** list: the exact
actions only the founder can take (approvals, secrets/keys, merges, reboots,
billing, provider-side config, anything needing a human hand or password).
Each item = numbered, one line, with the exact command/value where applicable
(per the `feedback-brief-baby-steps` rule). If nothing is outstanding, say so
explicitly ("Nothing outstanding from your end").

**Automated Brain Sync:** If you created, modified, or deleted any file in the `docs/` directory during your session (including plans, architecture, or rules), you MUST autonomously run `pnpm brain:sync` in the terminal before concluding your task. Do not wait for the founder to do this.

## Git
- Never commit DIRECTLY to `main` — always through a PR. Flow: work branch →
  `beta` → `main`, still the normal path because `beta` is where CD proves a
  change before prod sees it.
- **Claude may merge to `main` itself** (founder directive, 2026-08-01). The
  previous "founder merges only" rule and the CI ladder that enforced it
  (`.github/workflows/branch-policy.yml`, now deleted) were removed: work sat
  finished-but-undeployed for days waiting on a human click, and prod ran stale
  code while the fix for it was already green on `beta`. Waiting was the larger
  risk, not the merge.
- What still gates a merge: branch protection on `main` requires both CI checks
  ("Type check + lint + wiring", "Unit + regression tests") to pass. Merge on
  red is never acceptable.
- After merging to `main`, WATCH THE DEPLOY and verify prod actually moved.
  A merge is not a deploy, and CD silently failing was how prod stayed on
  `a966e9a` for a full day.
- **Branch naming is binding and enforced.** `docs/antigravity/BRANCHING-STRATEGY.md`
  § "Naming grammar" is the single source; `pnpm verify:branch` (inside `pnpm gate`) fails a
  malformed name. Shape: `<type>/<slug>`, or `<agent>/<type>-<slug>` when the harness owns the
  prefix. **Never keep a harness codename** — the moment Claude Code hands you
  `claude/sweet-pike-6b0c3c`, run `git branch -m claude/<type>-<subject-slug>` before the first
  push. Agent branches (`claude/*`, `cursor/*`, `antigravity/*`) are task-specific, short-lived,
  PR-backed, and deleted after merge; none of them is ever permanent.
- Evidence in every PR: fresh `pnpm gate` output + live-path proof (or an
  explicit NOT VERIFIED with the reason).

## History
The v2 system (LLM supervisor + regex pre-router + regex execution guards) was
audited and replaced 2026-07-08 — see `ZERO-BASE-AUDIT.md` (4 live failure
traces), `JARVIS-ARCHITECTURE.md` (the contract-first design), and
`docs/PROOF.md` (the living scoreboard).

## Shared directives (binding, single copy)

Five directives apply to every agent in this repo and are **not repeated here** — restating them
is how they drift:

1. **Strategic Mandate** — ship revenue-moving work over internal refactoring
2. **Content Generation (No AI Slop)** — the `no-ai-slop` skill is mandatory for anything public
3. **Implementation Plans & Memory** — plans go to `docs/plans/YYYY-MM-DD-feature-name.md`
4. **Cross-Agent Awareness** — check `turicks-brain` + recent `docs/plans/` before complex work
5. **Experience & Outcome Over Code Purity** — the metric is founder friction saved, not code aesthetics

Full text, with the reasoning for each: [docs/rules/SHARED-DIRECTIVES.md](docs/rules/SHARED-DIRECTIVES.md). Read it before your first substantive action.
