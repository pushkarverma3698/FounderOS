# Release Process — The Weekly Train

This sits on top of [BRANCH-MODEL.md](./BRANCH-MODEL.md) (`feat/* → beta → stable → main`).
The branch model says *how code flows*; this doc says *when it ships and what bar it must
clear*. One sentence: **features are built and integrated Mon–Thu, frozen Thursday, and
promoted to production every Friday — and a feature only ships when it is complete and
proven, never because the calendar says Friday.**

## Cadence

```
 Mon        Tue        Wed        Thu              Fri
 ──build──▶ ──build──▶ ──build──▶ freeze 17:00 ──▶ RELEASE
 feat/* cut from stable, merged to beta as they pass    beta→stable→main
 continuous integration on beta                          CD deploys to VPS
```

| Day | Activity |
|---|---|
| **Mon–Thu** | Cut `feat/*` from `stable`. Build with Claude Code. Each feature, when its gate passes, merges to `beta`. Integration + eval run continuously on `beta`. |
| **Thu (freeze)** | No new features to `beta` after the freeze. Only stabilization fixes. Run the full beta verification (below). |
| **Fri (release)** | If `beta` is green + live-verified: PR `beta → stable` (founder merges), then `stable → main` (founder merges) → CD auto-deploys. Post-deploy audit. |

**Throughput target: 4–5 features/week.** This is a ceiling, not a quota. A half-finished
fifth feature does **not** ship — it waits for next Friday's train. Scope each feature so
one can realistically pass its full gate inside the week.

## Definition of Done (a feature may merge to `beta` only when ALL hold)
Ties to CLAUDE.md rules #19, #23, #24.
1. **Unit + regression tests green** (`pnpm test`, mocked, $0) — includes a regression test for any bug fixed (rule #19.2).
2. **`pnpm lint` / `tsc --noEmit` clean** — zero errors (rule #16).
3. **Code review done** (`code-reviewer` agent or human) — no CRITICAL/HIGH open.
4. **Real-path evidence** for anything observable — the actual output, not "should work" (rule #24). For agent-behaviour changes: a probe or eval run, not just unit tests.
5. **Docs + memory updated** — ADR for any decision; `pnpm brain:sync`; `MEMORY.md` line.

## Quality gates per stage

| Stage | Gate | Who |
|---|---|---|
| `feat/*` → `beta` | Definition of Done above; CI green; branch-policy pass | agent/human opens PR |
| `beta` (continuous) | Integration + `pnpm eval` (routing/tool/HITL golden set, no regression); live MTProto QA on the **beta** behaviour for any HITL/gateway change | whoever merged |
| `beta` → `stable` | Thursday freeze passed; full beta verification green; Friday release checklist started | **founder merges** |
| `stable` → `main` | Release checklist complete; rollback plan known | **founder merges** → CD deploys |
| post-`main` | Deploy log green (Password synced OK, no `28P01`, `/health` ok); post-deploy audit | automatic + founder |

## Friday Release Checklist
Run top-to-bottom; stop and fix on any ❌.
1. `git fetch --all --prune`; confirm `beta` is the intended release set.
2. `pnpm lint && pnpm test` on `beta` → green.
3. `pnpm eval` → no regression vs the golden set (routing ≥ baseline, HITL coverage intact).
4. **Live MTProto QA** (`scripts/e2e-telegram-qa.ts`) on the beta build — at least one read, one write+HITL approve, one reject. Evidence = bot reply + matching `action_log` row.
5. PR `beta → stable`; founder merges.
6. PR `stable → main`; founder merges → CD fires.
7. **Watch the deploy** (`gh run watch`): `Password synced OK` → migrations without `28P01` → `brain:sync OK` (embedded rows > 0) → service restart → on-box `/health` green.
8. Post-deploy: confirm `/health` is **not "degraded"** (check email/RAG/integrations). Run the production audit if anything is degraded.
9. Update `MEMORY.md` + `pnpm brain:sync`.

## Emergency hotfix (production broken between Fridays)
The weekly train is the default, not a straitjacket. When prod is **down or data-losing**:
1. Cut `fix/<desc>` from `stable` (or `main` if `stable` is behind).
2. PR → `beta`, verify the fix on the real path.
3. Fast-track `beta → stable → main` with founder approval — the **only** sanctioned path that skips the Friday wait.
4. A direct `fix/* → main` PR is allowed **only** for an active prod outage where beta round-tripping would extend downtime (e.g. the 2026-06-25 deploy-script bug, PR #233). Branch-policy will flag it; that flag is the audit trail, not a blocker. Document the exception in the PR body.

## Rollback runbook
CD deploy is fail-loud: any step failing aborts and **the old instance keeps running**
(systemd only restarts at the very end of `deploy.sh`). So a failed deploy ≠ prod down.
- **Deploy failed mid-way:** prod is still on the previous good build. Fix forward (preferred) or revert the offending commit on `main` and let CD redeploy.
- **Deploy succeeded but prod is bad:** `git revert` the merge on `main` → CD redeploys the previous state. Or on the box: `cd /opt/founderos && git checkout --force --detach <last-good-sha> && sudo systemctl restart founderos` as a stopgap, then revert on `main`.
- **DB migration bad:** migrations are forward-only; restore from the most recent `pg_dump` and re-run. Keep a pre-release dump on big-migration Fridays.
- Always confirm recovery with on-box `/health` + a real MTProto probe.

## Why this process
The recurring failures in this project (wedged threads, duplicate bots, stale replies,
empty RAG, the deploy-script bug) all passed unit tests while failing in production.
The train enforces the missing layer: **a freeze, a live-verification gate, and a
human-merged promotion ladder** so nothing reaches `main` without real-path proof.
See ADR-039.
