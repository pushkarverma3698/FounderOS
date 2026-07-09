# Release Readiness Audit — 2026-06-27

Senior QA/CTO audit of real production state (VPS `founder-os`, `founderos@95.217.162.12`) plus local `main`. Supersedes `RELEASE-READINESS-AUDIT-2026-06-25.md`. All findings are evidence-backed from the live box, not assumed.

## Verdict: 🟡 DEGRADED — main was undeployable (fixed in PR #241); email/calendar fully down; engineering executor spend-limited.

## Deployed vs. main
- **Prod deployed commit:** `186f077` (LinkedIn engagement #239). Detached HEAD at `/opt/founderos`.
- **`origin/main`:** `4c6fe8d` — PR #240 merged the MCP client bridge. **Prod is 5 commits behind main.**
- **Why prod is stuck:** PR #240 merged an **outdated `pnpm-lock.yaml`** (`@langchain/mcp-adapters@^1.1.3` added to `package.json`, never locked). `pnpm install --frozen-lockfile` — the exact deploy step — **fails**. → **main was undeployable.** Fixed: **PR #241** (lockfile-only; frozen install passes, tsc clean, 1468/1468 green).

## Crown jewels — DB intact ✅ (never drop these volumes)
`docker founderos-postgres`, live `pg_stat_user_tables`:
`turicks_brain=239` · `knowledge_entries=93` · `checkpoints=943` (+`checkpoint_writes=1407`, `checkpoint_blobs=2178`) · `hitl_approvals=62` · `action_log=41` · `dept_signals=14` · `personal_rag=4` · `episodic_memory=3` · `missions=2` · `conversations=1` · `founder_context=1` · `integration_accounts=0` (multi-company resolves by env convention today).

## Status board

| Area | Status | Evidence |
|---|---|---|
| Local `main` (lockfile-fixed) | 🟢 | tsc clean · **1468/1468 tests** · `--frozen-lockfile` passes |
| Postgres + data | 🟢 | `database: up`; row counts above; 13-day uptime |
| Model path | 🟢 | Gemini 2.5 Flash via OpenRouter; coherent routing; ~$0.001/turn (trace seam) |
| RAG / knowledge | 🟢 | `/health rag: ok` — 93 entries, 239 vectors |
| OpenRouter fallback | 🟢 | `OPENROUTER_API_KEY` SET (len 73) — armed (better than prior audit assumed) |
| LinkedIn | 🟢 | `LINKEDIN_BACKEND=direct` (v202506), off Composio |
| Infra (disk/mem/uptime) | 🟢 | 56G free, 6.7G mem free, up 13 days |
| **Deployability of main** | 🔴→🟢 | **was broken** (lockfile); fixed in **PR #241** (awaiting merge) |
| **Email + Calendar** | 🔴 | `/health gmail_active: down`. Both backends dead: `gws` (`GWS_BIN` + `GOOGLE_APPLICATION_CREDENTIALS` MISSING) and `composio` (SDK drift 0.10.0↔0.12.0: `client.connectedAccounts.get is not a function`). → **Phase 1 `googleapis` adapter** |
| **claude_code executor** | 🔴 | Log Jun 26 12:36: *"You've hit your monthly spend…"* exitCode 1. Engineering code-exec + PR-creation down; Phase 3 CTO subgraph depends on it. Needs Claude billing/quota or API-key billing path |
| ANTHROPIC_API_KEY (judge) | 🟡 | SET but **len 37** — too short for a real `sk-ant-…` (~108 chars) → likely placeholder → judge gate ~no-op. Needs valid key |
| APIFY_TOKEN (research engine) | 🟡 | **MISSING** in prod `.env`. ADR-037 Apify scrape/deep-research/crawl degraded; research falls back to Firecrawl/web-search |
| Auto brain sync | 🟡 | Log Jun 26 02:05 level-50 *"Auto brain sync failed"* (stderr empty) despite `--env-file` fix `d400b1d` — investigate |
| Composio SDK | 🟡 | `composio-core 0.10.0` behind 0.12.0; moot after Phase 1 migration off Composio |
| Branch sprawl | 🟡 | Stale remote: `cursor/vps-*` (×3, Jun 18), `claude/social-media-recruitment-*` (Jun 26, abandoned); review `claude/s3-asset-storage-*` (Jun 26, may have value) before deleting |
| Prod `.env.bak.*` | 🟢 | `.env.bak.1782118683` untracked on box (deploy backup) — housekeeping only |

## Immediate ordered actions
1. **Merge PR #241** → unblocks deploys, brings prod current (bridge gated off). *Outward-facing (CD deploy) — founder confirms.*
2. **Phase 1:** `googleapis` service-account adapter → restore email/calendar unattended; arm valid `ANTHROPIC_API_KEY`; add `APIFY_TOKEN`; clean redeploy preserving DB.
3. **Resolve `claude_code` spend limit** (Claude billing or API-key executor path) before Phase 3.
4. Investigate auto-brain-sync failure; branch hygiene.

## Secrets the founder must supply (gate Phase 1)
Google service-account JSON (domain-wide delegation: `gmail.send`, `gmail.readonly`, `calendar.events`) · valid `ANTHROPIC_API_KEY` · `APIFY_TOKEN` · (OpenRouter already armed).
