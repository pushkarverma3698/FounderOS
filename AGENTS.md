# FounderOS — agent instructions

Generic rules (roles, Lite/Full, evidence, git, brain, writing style) live in `~/.agents/AGENTS.md`. This file is what is true of this repo.
Canonical copy: `CLAUDE.md` imports it, `GEMINI.md` points here. Repo precedence: founder in chat > CI (`scripts/verify-architecture.ts`) >
`docs/antigravity/STANDARDS.md` (binding: how code is written; read it before the first edit) > this file > reference. A rule CI does not enforce is a convention.

Brain project tag: `founderos`.

## What runs and where
Since 2026-10-10 (tag `archive/founderos-v3`) FounderOS is jobs-only. The kernel, planner and JARVIS UI are gone. Node 22, TypeScript strict, grammy, drizzle/Postgres.
- `src/jobs/main.ts` → `founderos.service`: single-instance lock, health server, jobs bot (commands, `jh:` buttons, Mini App apply), jobs crons.
- `src/mcp/hub.ts` → `founderos-hub-http.service`: the `turicks-brain` MCP hub (brain search/writes, Gmail and Calendar reads).
- `scripts/sync-turicks-brain.ts` → nightly `brain-sync.yml`: re-indexes `docs/` into `brain.brain_memories`. Run `gh workflow run brain-sync.yml` after a `docs/` change merges. `pnpm brain:sync` refuses to run off the VPS (`--local` for tests).
- Prod VPS: `ssh founderos-vps '<cmd>'`, passwordless `sudo -n`. Detail: `.claude/rules/prod-vps.md`.

## Commands that prove it works
```bash
pnpm install --frozen-lockfile
pnpm test                        # vitest, keyless, $0
pnpm lint && pnpm verify:arch    # types + anti-slop gates
pnpm gate                        # CI's merge gate: lint, build, runtime assets, wiring, arch, doc claims, test (= pnpm predeploy)
node --import tsx/esm --env-file=.env scripts/telegram-probe.ts "/jobs"   # real path: Telegram → jobs bot → tool → reply (spends money)
```
Use `cmd > /tmp/x-$$.log 2>&1; echo "exit=$?"`: `| tail` hides the exit code. Needs Postgres with pgvector (`sudo pg_ctlcluster 16 main start`); setup is `pnpm run setup` (`pnpm setup` is pnpm's own command).
A bad `TELEGRAM_BOT_TOKEN` makes the process exit about 1s after boot. `pnpm test:integration` needs a real Gemini key.

## Branches and deploy
- Flow: work branch → `beta` → `main`. Cut from fresh `origin/main`, open a draft PR to `beta`, merge `origin/beta` in before pushing. Never commit to `main`.
- Promotion: `git checkout -B chore/promote-<slug> origin/main && git merge origin/beta`; merge with `gh pr merge --merge`, never `--squash`. Merge to `main` only on green CI (both required checks).
- Deploy: `deploy.yml` runs after CI passes on `main`. Confirm prod moved with `ssh founderos-vps 'systemctl show founderos -p ActiveEnterTimestamp'`, not `git rev-parse HEAD`.
- Branch names: `docs/antigravity/BRANCHING-STRATEGY.md` § "Naming grammar" (`<type>/<slug>`); `pnpm verify:branch`. Rename a harness codename before the first push. Ladder: `docs/process/BRANCH-MODEL.md`.

## Rules CI enforces
1. Tombstones: deleted modules (`src/kernel`, `kernel-boot.ts`, `kernel-run.ts`, office-run, pre-router…) fail if re-created — `verify-architecture.ts`; `tests/unit/jobs/jobs-entry.test.ts` fails if a kernel import returns.
2. Ratchet: `governance/architecture-baseline.json` debt may only shrink.
3. Only `src/gateway` and `src/jobs` import `src/gateway`; every src subsystem is imported by src or a script; no exported `*_RE` control-flow regexes.
4. No src file over 400 lines.
5. Fail-open catches carry `// allow-failopen: <reason>`.
6. A PR adding a code or script file has a `Checked first:` line; every PR names a `Moves:` outcome — `scripts/verify-pr-scope.ts`.
7. Branch name grammar — `pnpm verify:branch`. Doc claims (test counts etc.) match generated `docs/PROOF.md` — `pnpm verify:doc-claims`.

## Hard limits (production)
1. Never edit files or `git checkout` in `/opt/founderos` on the VPS: deploy writes that tree; code reaches prod only through PR → deploy. Review checkouts go in `/opt/review/<repo>`.
2. Anything sent on the founder's behalf waits for his approval: DB row first (`src/infra/hitl.ts`), side effect after approval, idempotency-key check before every external send, audit row only on real success.
3. Tools call `src/infra/providers/`, never gws or platform REST directly (ADR-029).
4. No paid OpenRouter fallback, ever. The model chain lives only in `scripts/apply-prod-env-overrides.sh`; do not mirror it into markdown. Detail: `.claude/rules/model-policy.md`.
5. Keep secrets and personal data (UPI ids, phones, keys) out of brain rows and docs.

## Conventions (not enforced)
- Routing, parsing and guards are pure unit-tested functions, never prompt instructions. Temperature 0.
- Ambiguous requirement: ask for the missing field; never guess data.
- Founder-facing output is actionable without reading code: each reason printed with its own result; split a Telegram message rather than hide a row (#26).
- After a deploy, drive the change through the real path yourself (Telegram probe, real tool) and show the output. FounderOS is the founder's own harness, so prod has no customers to protect; never hand the live test back.
- Zero paid calls in the dev loop: failing unit test first, then ONE live run of `scripts/probe-*.ts` or the Telegram probe.
- Plans go to `docs/plans/YYYY-MM-DD-<feature>.md`, session notes to `docs/sessions/YYYY-MM-DD-<topic>.md` (`TEMPLATE.md`) when a session merges non-trivial work. Retire a doc with `**Status:** Superseded by …` in its first 20 lines.
- Anything public uses the `no-ai-slop` skill. The metric is founder friction saved, not code aesthetics.
- Close each session with **"Outstanding from your end"**: numbered actions only the founder can take, one line each with the exact command. If none: "Nothing outstanding from your end".

## File map
```
src/jobs/        main.ts (composition root), bot.ts, scheduler.ts (crons), health.ts
src/gateway/     jobhunt-* (commands, buttons, views), apply-* (Mini App), profile-*, telegram-poll.ts
src/tools/       jobhunt/ (sources, scoring, forms), apify, career, web-search
src/agents/      model.ts (error taxonomy), worker-invoke.ts, agent-tools/    src/evolution/  jobhunt analyzers
src/infra/       hitl, budget, logger, single-instance, account-registry, providers/
src/db/ schema + queries, rag-*    src/mcp/ brain hub    src/core/ config    video-factory/ standalone engine
```

## Read on demand
| Task touches | Read first |
|---|---|
| Any code | `docs/antigravity/STANDARDS.md` |
| New tool | `docs/rules/TOOL-STANDARDS.md`, `TOOL-INTEGRATION-PLAYBOOK.md` |
| Tests | `docs/rules/TESTING-RULES.md`, `TEST-PYRAMID.md` |
| Reviewing a PR | `docs/rules/CODE-REVIEW-CHECKLIST.md` |
| Dispatching to Antigravity | `docs/antigravity/README.md` § "Before you dispatch" |
| Why a rule exists | `docs/rules/CLAUDE-RULES-RATIONALE.md` |
| Deploy, scripts, infra | `.claude/rules/prod-vps.md` |
| Models, `src/agents`, eval | `.claude/rules/model-policy.md` |
| `docs/`, brain sync | `.claude/rules/docs-and-brain.md` |
| `video-factory/` | `.claude/rules/video-factory.md` |
