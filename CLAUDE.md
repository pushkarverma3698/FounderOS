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

Path-scoped detail lives in `.claude/rules/` and loads only when you touch matching files:
`prod-vps.md` (deploy/scripts/infra), `model-policy.md` (agents/eval), `docs-and-brain.md` (docs), `video-factory.md`.

## What this is
A deterministic agent kernel with a Telegram gateway that runs Turicks operations. Node 22 + TypeScript
strict + LangGraph StateGraph (no prebuilt supervisor) + grammy + drizzle/Postgres + injected models (temp 0).

```
message → plan (LLM: direct reply OR typed Plan)
        → dispatch (pure-code supervisor: plan[cursor] → TaskEnvelope)
        → agent ⇄ tools (isolated envelope context, code-recorded ToolReceipts, HITL interrupt() in gated tools)
        → collect (StepResult validated against OUTPUT_CONTRACTS) → … → synthesize (results only) → reply + receipts
```

- Contracts are the architecture: `src/kernel/contracts.ts`. Every boundary is Zod-validated; a mismatch is a terminal, typed failure.
- Action claims require successful receipts (`validateStepResult`); the synthesizer sees only validated results.
- FailureReport = stage + component + evidence + retryable. Threads are never wiped, except by the founder's `/reset`.
- `src/gateway/kernel-boot.ts` is the only composition root. The full graph runs offline in CI at $0 (`tests/unit/kernel/kernel-e2e.test.ts`).

## Anti-slop invariants (CI-enforced — scripts/verify-architecture.ts)
1. Tombstones: killed modules (office-run, execution-guard, pre-router, fast-paths, office.ts, domain subgraphs…) fail CI if re-created.
2. Ratchet: `governance/architecture-baseline.json` debt may only shrink.
3. Import direction: contracts ← kernel ← gateway; kernel imports only kernel/core/db/infra/tools.
4. No src file over 400 lines.
5. Fail-open catches need an `// allow-failopen: <reason>` tag.

## Non-negotiable rules
Rationale and incidents: [docs/rules/CLAUDE-RULES-RATIONALE.md](docs/rules/CLAUDE-RULES-RATIONALE.md). Read the entry before arguing with a rule.

- **HITL**: DB row before `interrupt()` (`src/infra/hitl.ts`); side effects only after approval; idempotency-key check before every
  external send; audit row only on real success. Each side-effecting tool in `src/agents/agent-tools/` calls `hitlGate()` inline;
  `HITL_GATED_TOOLS` is a rendering declaration, not a gate.
- **Determinism**: temp 0; routing/parsing/guards are pure unit-tested functions, never prompt instructions; CI runs the golden set twice.
- **Evidence (#24/#34/#36)**: "done" = the verification command run fresh in this session with output shown, through the real path
  (Telegram → kernel → tool → reply → `action_log` row). After a jobhunt/gateway fix, drive it through Telegram
  (`scripts/telegram-probe.ts`). Otherwise write **NOT VERIFIED — reason**. Every PR body names one real-path assertion.
- **Live-test everything yourself (founder, 2026-10-07)**: FounderOS is the founder's own harness, not a user-facing product, so prod has no customers to protect. After every deploy, drive the change through the real path yourself (Telegram probe, real GitHub, real tool) and show the output. Never hand the live test back to the founder. If a live run is impossible, say NOT VERIFIED and why.
  You act as the founder through the MTProto tester, run on the VPS as the `founderos` user (`sudo -n -u founderos -H bash -lc 'cd /opt/founderos && node --import tsx/esm --env-file=.env scripts/telegram-tester.ts send "<text>" --wait N'`; also `click <label>`, `approve`, `reject`, `read [n]`): send the message, tap the spec Approve and the evidence-card Merge (`click`; `approve` is only for HITL gate cards), read every reply. There is no staging, so prod is the test environment: aim anything that must not really merge at `fos-journey-sandbox`, and never merge an Oplify PR into production. Still the founder's own: browser consent (`/login google …`), secrets, and the choice to merge Oplify to production.
- **Fix the schema, not the code**: ambiguous requirements → the planner asks for the missing field; never guess data.
- **Bug fixes start with a failing test** (PR template section is mandatory).
- **#25**: before non-trivial work, grep for an existing implementation, name the binding constraint, state the strongest argument against your plan.
- **#26**: founder-facing output is actionable without reading code: every reason printed with its own result; split a Telegram message rather than hide a row.
- **Zero paid calls in the dev loop**: `pnpm test` is $0. `scripts/probe-*.ts`, `scripts/e2e-telegram-qa.ts` and `pnpm eval` spend
  money: failing unit test first, then ONE live run. `pnpm qa:telegram` runs once, when the PR is about to go up.
- **Episodic memory**: a session that merges non-trivial work writes `docs/sessions/YYYY-MM-DD-<topic>.md`.

## Rules binding on Claude
- **#27** A rule with no mechanism decays: name the enforcing layer (CI, script, hook, nothing) and prefer CI.
- **#28** Approval authorizes work, it does not verify it. If an approved plan is wrong, say so before building.
- **#29/#33** Review is not delegable. A subagent's or other AI's claim is an input to verify.
- **#30** Before accepting a redirect, name the in-flight work it displaces.
- **#31** Status relayed through a human is unverified: run `~/Projects/scripts/ai-tools/agy-guard`, commit, then read.
- **#32** Review every Antigravity brief against `docs/antigravity/README.md` § "Before you dispatch".
- **#35** Freshness against the source: a PR verdict is stale once the head moves.

## File map
```
src/kernel/            contracts, signals, state, planner, supervisor (pure), worker, synthesizer, graph, verify
src/gateway/           kernel-boot.ts (composition root), kernel-run.ts (lock → gates → invoke → HITL/reply),
                       telegram.ts (grammy), commands.ts
src/agents/            worker prompts, agent-tools/ (LangChain wrappers), capabilities.ts, model.ts (error taxonomy)
src/tools/             UnifiedTool implementations (ToolResult envelope)
src/infra/             hitl, checkpointer, budget, daily-budget, trace, scheduler (maintenance only), health
src/db/                schema (20 tables) + queries; src/eval/ golden tasks; src/proof/ renderers; src/mcp/ read-only MCP
video-factory/         standalone client video engine (see .claude/rules/video-factory.md)
```

## Commands
```bash
pnpm test                       # deterministic suite ($0, scripted models)
pnpm lint && pnpm verify:arch   # types + anti-slop gates
pnpm gate                       # full merge gate (branch name + lint + build + wiring + arch + test)
pnpm eval                       # live golden-set eval (paid)
pnpm qa:telegram                # 22-task MTProto founder simulation (paid, once per PR)
```
Use `cmd > /tmp/x-$$.log 2>&1; echo "exit=$?"`: `| tail` hides the exit code.

## Prod VPS
`ssh founderos-vps '<cmd>'` with passwordless `sudo -n`. Never edit files or `git checkout` in `/opt/founderos`: code reaches prod
only through PR → deploy. Detail: `.claude/rules/prod-vps.md`.

## Git
- Never commit directly to `main`. Flow: work branch → `beta` → `main`. Claude may merge to `main` when both required CI checks are green; never on red.
- After merging to `main`, watch the deploy and verify prod moved.
- Branch names follow `docs/antigravity/BRANCHING-STRATEGY.md` § "Naming grammar" (`pnpm verify:branch`). Rename a harness codename branch before the first push.
- Every PR carries fresh `pnpm gate` output and live-path proof, or NOT VERIFIED with the reason.

## Sessions and compaction
- One task per session; investigate, implement and review in separate sessions, handing off through a file.
- When compacting, keep: branch, modified files, verification commands and their results, open NOT VERIFIED items, founder decisions.

## End-of-session handoff (always)
Close with **"Outstanding from your end"**: the actions only the founder can take, numbered, one line each, with the exact command or
value. If none: "Nothing outstanding from your end".

## Shared directives
Strategic mandate, no AI slop, plans in `docs/plans/`, cross-agent awareness, outcome over code purity:
[docs/rules/SHARED-DIRECTIVES.md](docs/rules/SHARED-DIRECTIVES.md). Read it before your first substantive action.
History: v2 was replaced 2026-07-08 (`ZERO-BASE-AUDIT.md`).
