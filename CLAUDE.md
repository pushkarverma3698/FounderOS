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


## Non-negotiable rules
Full text and the incident behind each rule: [docs/rules/CLAUDE-RULES-RATIONALE.md](docs/rules/CLAUDE-RULES-RATIONALE.md).
Read the entry before arguing with a rule.

- **HITL**: DB row BEFORE interrupt() (`src/infra/hitl.ts`); side effects only after approval;
  idempotency key check before every external send; audit row only on real success. Each
  side-effecting tool in `src/agents/agent-tools/` calls `hitlGate()` inline — there is no single
  adapter, and `HITL_GATED_TOOLS` is a rendering declaration, not a gate.
- **Determinism**: temp 0; routing/parsing/guards are pure unit-tested functions, never prompt
  instructions; CI runs the golden set twice — plans must be identical.
- **#24 Evidence over assertion**: "done" = the verification command run fresh in this session with
  output shown. Exercise the real path (Telegram → kernel → tool → reply → `action_log` row), not a
  tool's `.execute()` over SSH. After any jobhunt/gateway fix, drive it through Telegram
  (`scripts/telegram-probe.ts`, `scripts/lib/mtproto.ts`) before calling it done. Otherwise say
  **NOT VERIFIED — reason**.
- **Fix the schema, not the code**: ambiguous requirements → the planner asks for the missing field; never guess data.
- **Bug fixes start with a failing test** (PR template section is mandatory).
- **#25 Before non-trivial work**: grep for an existing implementation, name the binding
  constraint, state the strongest argument against your plan. Recommend one option, never an
  unranked survey.
- **#26 Outcome over instruction** (FounderOS specifics): founder-facing output must be actionable
  and legible without reading code — print every reason with its own result, split the Telegram
  message rather than hide a row. Never discard collected data before the stage where the reason is
  stored and shown.
- **Episodic memory**: any session that completes or merges non-trivial work writes
  `docs/sessions/YYYY-MM-DD-<topic>.md` from `docs/sessions/TEMPLATE.md`, then runs brain sync (below).
- **Zero paid calls in the dev loop**: `pnpm test` is $0 (scripted models); a test making a real LLM
  call is a bug. While iterating use `AGENT_MODEL=openrouter:google/gemini-2.5-flash-preview-05-20:free`
  (fallback `openrouter:deepseek/deepseek-r1:free`), never `google-genai:*`. `scripts/probe-*.ts`,
  `scripts/e2e-telegram-qa.ts` and `pnpm eval` spend real money: failing unit test first, then ONE
  live run. `pnpm qa:telegram` runs once, when the PR is about to go up.

## Rules binding on Claude (from measured failures; enforcement named)
- **#27** A rule with no mechanism decays. When proposing a rule, say which layer enforces it (CI, script, or nothing) and prefer converting it into CI. *Enforced by: nothing.*
- **#28** Founder approval authorizes work; it does not verify it. If an approved plan is wrong, say so before building, then build the corrected version. *Enforced by: judgement.*
- **#29 / #33** Review is mine and not delegable. A subagent or other AI's claim is an input: verify it against evidence before repeating or rejecting it, and accept it fully when it holds. *Enforced by: judgement.*
- **#30** Name the displacement before accepting a redirect: what in-flight work it displaces and what the delay costs. *Enforced by: nothing.*
- **#31** Status relayed through a human is unverified. Run `~/Projects/scripts/ai-tools/agy-guard`, commit, then read. *Enforced by: agy-guard (exit 1 while a conversation is live).*
- **#32** The brief is the defect surface. Review every Antigravity brief against `docs/antigravity/README.md` § "Before you dispatch". *Enforced by: nothing yet.*
- **#34** Every "done" claim (self-diagnosis, PR body, dispatch-brief acceptance criteria) names a command actually run and its actual output, or says NOT VERIFIED — reason. A missing instrument is reported as missing. *Enforced by: nothing yet (mechanism: `docs/plans/2026-09-16-mechanism-claimed-done-verification.md`).*
- **#35** Check freshness against the source, not a proxy: a PR verdict is stale once the head moves; a copied script is stale once `main` moves. *Enforced by: deploy-staleness check only.*
- **#36** Every PR body and Antigravity brief names one real-path assertion, or says NOT VERIFIED — reason. *Enforced by: nothing yet (mechanism: `docs/plans/2026-09-16-mechanism-realpath-verification.md`).*

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


## Brain (shared memory for Claude and Antigravity)
- Before non-trivial work: `search_memory` (turicks-brain MCP) with `project: "founderos"`. Treat hits
  as leads; verify against the code.
- After real findings: `save_decision` / `save_bug` / `remember` with `project: "founderos"`. No secrets or
  personal data (UPI ids, phone numbers, keys) in brain rows — every agent reads them.
- **Brain sync** runs on the VPS: nightly (`.github/workflows/brain-sync.yml`) and on demand with
  `gh workflow run brain-sync.yml`. After changing anything under `docs/`, trigger it once the change
  is merged. `pnpm brain:sync` refuses to run on any machine but `founder-os` (the brain every agent
  reads), because a laptop run used to print `✅ Sync complete` after writing a local database nobody
  reads. `--local` allows it for testing and labels the output LOCAL. Every synced row carries a
  project (`founderos`, or `turicks` for the brand guide).

## End-of-session handoff (ALWAYS)
Close every session, and every substantive piece of work, with **"Outstanding from your end"**: the
exact actions only the founder can take (approvals, secrets, merges, reboots, billing, provider
config), numbered, one line each, with the exact command or value. If none: "Nothing outstanding
from your end".

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
v2 (LLM supervisor + regex pre-router) was replaced 2026-07-08 — see `ZERO-BASE-AUDIT.md`, `JARVIS-ARCHITECTURE.md`, `docs/PROOF.md`.

## Shared directives (binding, single copy)

Five directives apply to every agent in this repo and are **not repeated here** — restating them
is how they drift:

1. **Strategic Mandate** — ship revenue-moving work over internal refactoring
2. **Content Generation (No AI Slop)** — the `no-ai-slop` skill is mandatory for anything public
3. **Implementation Plans & Memory** — plans go to `docs/plans/YYYY-MM-DD-feature-name.md`
4. **Cross-Agent Awareness** — check `turicks-brain` + recent `docs/plans/` before complex work
5. **Experience & Outcome Over Code Purity** — the metric is founder friction saved, not code aesthetics

Full text, with the reasoning for each: [docs/rules/SHARED-DIRECTIVES.md](docs/rules/SHARED-DIRECTIVES.md). Read it before your first substantive action.
