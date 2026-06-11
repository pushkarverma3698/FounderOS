# FounderOS — Production-Readiness Audit Log

> Audit branch: `prod-hardening` (forked from `fix/engine-swap-reliability` — the current engine-swap HEAD, the real code in use).
> Prime directive: **evidence over claims.** Every "works/passes/fixed" below is backed by a pasted command result. Anything unverified is labelled `NOT VERIFIED`.

---

## Phase 0 — Ground Truth (env & build) — 2026-06-11

### Toolchain
| Item | Result |
|------|--------|
| `node -v` | `v22.22.1` ✅ (engines require >=22) |
| `pnpm -v` | `11.0.9` |
| `pnpm install` | Already up to date. ⚠️ `ERR_PNPM_IGNORED_BUILDS`: bufferutil, es5-ext, utf-8-validate (optional native websocket deps — benign). |
| `tsc --noEmit` (direct) | **exit 0 — clean** ✅ |
| `tsc -p tsconfig.json` (build) | **exit 0 — clean** ✅ |

### Build-script finding (LOW)
- `pnpm lint` / `pnpm build` **fail before running tsc** because pnpm 11's `verify-deps-before-run` returns exit 1 on the ignored build scripts. Workaround used: run `./node_modules/.bin/tsc` directly. Real typecheck/build are clean.
- `pnpm start` → `node … dist/index.js`, but `tsc` emits to **`dist/src/index.js`** (outDir preserves `src/`). `pnpm start` would 404. Production runs via `tsx src/index.ts`, so dist is unused — **minor**, not a blocker.

### Capability Matrix (presence verified; values never printed)
| Dependency | Env key | Status | Evidence |
|------------|---------|--------|----------|
| Postgres | `DATABASE_URL` | **LIVE** | `pg` connect OK, db=founderos user=turicks, 15 public tables (checkpoints, hitl_approvals, action_log, knowledge_entries, …) |
| Redis | `REDIS_URL` | **LIVE** | `ioredis` PING → PONG |
| Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` | **LIVE** | REST `generateContent` HTTP 200, reply "PONG" |
| Anthropic (API) | `ANTHROPIC_API_KEY` | **MISSING** | not in `.env` |
| Claude Code (executor) | (subscription auth) | **LIVE** | `claude --version` → 2.1.114 at `~/.local/bin/claude` |
| Composio | `COMPOSIO_API_KEY` | **PRESENT** (live calls not yet exercised) | key set (len 23) |
| Firecrawl | `FIRECRAWL_API_KEY` | **PRESENT** | key set (len 35) — note: engine-swap demoted Firecrawl to fallback (402 seen historically) |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | **PRESENT** | both set |
| LangSmith | `LANGCHAIN_API_KEY` | **PRESENT** | set (len 51); `LANGSMITH_API_KEY` not set |
| GitHub | `GITHUB_TOKEN` | **PRESENT** | set (len 40) |
| `AGENT_MODEL` | — | unset → default `gemini-2.5-flash` |

### Infra note (MEDIUM — observability)
- Three DB containers run on the host: `turicks-postgres` (holds host :5432), `docker-postgres-1` (compose, **not** host-published), `docker-redis-1` (redis, not in `docker/docker-compose.yml` — the compose file has no `redis` service). So `DATABASE_URL`→localhost:5432 resolves to **`turicks-postgres`**, not the project's own compose postgres. Works, but the topology is ambiguous and undocumented.

### Correction to the mission's premise (important)
- `src/agents/model.ts` on this branch **already implements** exponential-backoff retry (`RETRY_BACKOFF_MS = [2000, 4000, 8000]`) and a fallback chain (`gemini-2.5-flash → gemini-2.5-flash-lite`). The mission was written against an **older baseline** (pre-retry). The audit will verify the *actual current* resilience layer, not re-add what exists.
- The mission's "fail over Gemini → Anthropic" is **not viable as written**: `ANTHROPIC_API_KEY` is absent and `model.ts` deliberately argues against multi-provider failover for a single-user tool. Decision respected; existing Gemini→lite fallback verified instead.

### Phase 0 Gate
✅ **MET** — repo typechecks + builds clean; capability matrix written. No build blocker (the pnpm-wrapper quirk is documented with a workaround).
