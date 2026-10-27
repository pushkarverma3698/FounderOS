# FounderOS — Claude Instructions (v4, jobs-only)

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
Since 2026-10-10 (fd58a2f5, tag `archive/founderos-v3`) FounderOS runs only the job pipeline. The kernel, planner,
coding pipeline and JARVIS UI are gone; coding from the phone is Claude Code Remote Control on the VPS (user `claude-agent`),
outside this repo. Node 22 + TypeScript strict + grammy + drizzle/Postgres.

- `src/jobs/main.ts` (`founderos.service`): single-instance lock, health server, the jobs bot (commands and `jh:` buttons), the
  jobs crons (sweep + daily brief, follow-ups, digest, funding grower, findings). `tests/unit/jobs/jobs-entry.test.ts` fails if a kernel import returns.
- `src/mcp/hub.ts` (`founderos-hub-http.service`): the `turicks-brain` MCP hub (brain search/writes, Gmail and Calendar reads).
- Nightly `brain-sync` (`scripts/sync-turicks-brain.ts`) re-indexes `docs/` from `/opt/founderos` into `brain.brain_memories`.

## Anti-slop invariants (CI-enforced — scripts/verify-architecture.ts)
1. Tombstones: deleted modules (`src/kernel`, `kernel-boot.ts`, `kernel-run.ts`, office-run, pre-router…) fail CI if re-created.
2. Ratchet: `governance/architecture-baseline.json` debt may only shrink.
3. Nothing outside `src/gateway` and `src/jobs` imports `src/gateway`.
4. No src file over 400 lines.
5. Fail-open catches need an `// allow-failopen: <reason>` tag.
6. No exported `*_RE` control-flow regexes; every src subsystem is imported by src or a script.

## Non-negotiable rules
Rationale and incidents: [docs/rules/CLAUDE-RULES-RATIONALE.md](docs/rules/CLAUDE-RULES-RATIONALE.md). Read the entry before arguing with a rule.

- **HITL**: anything sent on the founder's behalf waits for his approval: DB row first (`src/infra/hitl.ts`), side effect only after
  approval, idempotency-key check before every external send, audit row only on real success.
- **Determinism**: temp 0; routing/parsing/guards are pure unit-tested functions, never prompt instructions.
- **Evidence (#24/#34/#36)**: "done" = the verification command run fresh in this session with output shown, through the real path
  (Telegram command or Mini App → jobs bot → tool → reply). After a jobhunt/gateway fix, drive it through Telegram
  (`scripts/telegram-probe.ts`). Otherwise write **NOT VERIFIED — reason**. Every PR body names one real-path assertion.
- **Live-test everything yourself (founder, 2026-10-07)**: FounderOS is the founder's own harness, not a user-facing product, so prod has no customers to protect. After every deploy, drive the change through the real path yourself (Telegram probe, real tool) and show the output. Never hand the live test back to the founder. If a live run is impossible, say NOT VERIFIED and why.
- **Fix the schema, not the code**: ambiguous requirements → ask for the missing field; never guess data.
- **Bug fixes start with a failing test** (PR template section is mandatory).
- **#25 Verify and research before building**: before non-trivial work, search for what already exists (repo grep, the framework or product's own features and docs, open issues), name the binding constraint, state the strongest argument against your plan. An assumed fact is a hypothesis until a command or the docs confirm it. CI: a PR adding a code file needs a `Checked first:` line (`scripts/verify-pr-scope.ts`).
- **#26**: founder-facing output is actionable without reading code: every reason printed with its own result; split a Telegram message rather than hide a row.
- **Zero paid calls in the dev loop**: `pnpm test` is $0. `scripts/probe-*.ts` and live Telegram runs spend money: failing unit
  test first, then ONE live run.
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
src/jobs/              main.ts (composition root), bot.ts, scheduler.ts (jobs crons), health.ts
src/gateway/           jobhunt-* (commands, buttons, views), apply-* (Mini App apply flow), profile-*, telegram-poll.ts
src/tools/             jobhunt/ (sources, scoring, forms), apify, career, web-search
src/agents/            model.ts (error taxonomy), worker-invoke.ts, agent-tools/
src/evolution/         jobhunt analyzers (findings)
src/infra/             hitl, budget, logger, single-instance, account-registry, gws-runner
src/db/                schema + queries, rag-* (brain search); src/mcp/ turicks-brain hub; src/core/ config
video-factory/         standalone client video engine (see .claude/rules/video-factory.md)
```

## Commands
```bash
pnpm test                       # deterministic suite ($0)
pnpm lint && pnpm verify:arch   # types + anti-slop gates
pnpm gate                       # full merge gate (lint + build + runtime assets + wiring + arch + doc claims + test)
node --import tsx/esm --env-file=.env scripts/telegram-probe.ts "/jobs"   # real-path Telegram check (live)
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
History: v3 kernel retired 2026-10-10 (fd58a2f5); v2 replaced 2026-07-08.
