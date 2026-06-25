# Production Readiness Audit — 2026-06-25

Real-state audit of the live Hetzner VPS (`founder-os`), run over SSH per rule #22
(verify STATE, not schema). Every line below is backed by a real command output
captured during the audit, not an assumption.

## Verdict

🟡 **PROD IS UP BUT DEGRADED.** The bot is running, the database is healthy and
populated, and RAG is working. **Email send is fully down** (both backends), the
Claude-judge gate is a no-op (placeholder key), and the latest deploy (#232) never
completed — it aborted at the password-sync step on a shell bug, now fixed in PR #233.

## Evidence

### ✅ Healthy
| Component | Evidence |
|---|---|
| systemd service | `systemctl is-active founderos` → `active` / `running`, **0 restarts**, started 2026-06-25 12:37:20 UTC |
| Database | `/health` → `"database":"up"` |
| RAG store (turicks_brain) | `brain.turicks_brain = 239` rows, `brain.knowledge_entries = 93` — populated, no empty-store fabrication risk |
| personal_rag | `brain.personal_rag = 4` chunks |
| Founder context | `agents.founder_context = 1` (seeded) |
| Audit / HITL history | `agents.action_log = 41`, `agents.hitl_approvals = 61`, `agents.dept_signals = 14` |
| LangGraph checkpoints | `agents.checkpoints = 977` (+ blobs/writes) — durable state intact |
| Web gateway (JARVIS) | `/api/v1/health` → `{"ok":true,"transport":"web"}` |
| Migrations | `drizzle.__drizzle_migrations = 9` applied |

### ❌ Broken / Degraded
| Issue | Severity | Root cause (real error) | Fix path |
|---|---|---|---|
| **Email send down (Composio)** | HIGH | `Composio Gmail probe failed: client.connectedAccounts.get is not a function` — Composio SDK API/version mismatch | Pin/upgrade Composio SDK; update the probe call to the current API. Route through beta. |
| **Email send down (GWS)** | HIGH | `gws not ready: The argument 'file' cannot be empty. Received ''` — `GWS_BIN` is empty in prod `.env` | Install the gws CLI on the box + set `GWS_BIN` + `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`. Reference the preserved `cursor/vps-gws-*` branches. |
| **Deploy #232 never completed** | HIGH | `deploy.sh: line 94: DATABASE_URL: unbound variable` under `set -u` — my own password-sync bug | **Fixed in PR #233** (read DB pass from `.env`). Pending merge → deploy completes + restarts on new build. |
| **Claude-judge gate is a no-op** | MEDIUM | `ANTHROPIC_API_KEY` is a placeholder in prod `.env` (and local) — rule #21 gate 2 fails open silently | Founder supplies a real key from console.anthropic.com → set in `PROD_DOTENV`. |
| **LinkedIn (Turicks) inactive** | LOW | `LINKEDIN_ACCESS_TOKEN_TURICKS` / `_AUTHOR_URN_TURICKS` = `PENDING_LINKEDIN_APP_VERIFICATION` | Blocked on LinkedIn app verification (external). Personal LinkedIn token works (expires 2026-08-24). |
| **quota_check unwired** | LOW | `incrQuota()` exists but no send path calls it (carried from CLAUDE.md rule #14) | Add a Postgres daily send counter before any volume outbound. |

### ⚠️ Not run (honest gaps — rule #24)
- **Live MTProto founder-simulation QA was NOT run** in this audit (would incur a paid prod Gemini call, and email HITL would fail anyway with email down). Recommend running `scripts/e2e-telegram-qa.ts` once email is restored, before declaring "green."
- External `:3001` health is **not reachable by design** (services bind `127.0.0.1` only, ufw allows SSH only) — all health checks must run on-box.

## Immediate action queue (priority order)
1. **Merge PR #233** → unblocks the deploy (28P01 fix actually runs).
2. **Restore email** — fix Composio SDK probe + install GWS on the box. This is the single biggest functional gap (marketing/sales/jobhunt all depend on send).
3. **Set real `ANTHROPIC_API_KEY`** in `PROD_DOTENV` to activate the judge gate.
4. After 1–3: run one live MTProto QA pass as evidence, then re-audit.

## Environment sync (Workstream D result)
Local `.env` was reconciled against the live box `.env` (the source of truth):
- **All real secrets already match** between local and prod (OpenRouter, Google, GitHub, Composio, Firecrawl, personal LinkedIn, Telegram, MTProto). No local resync was needed.
- Intended dev/prod DIFFs only: `NODE_ENV`, `AGENT_MODEL`, `AGENT_FALLBACK_MODELS` (free vs paid model — correct).
- Box-only keys (correctly not local): `LOG_LEVEL`, `STATIC_SITE_PUBLIC_BASE_URL`, `STATIC_SITE_HOME_ROOT`.
- **DB password confirmed: `founderos`** (from box `DATABASE_URL`).
- Shared gap: `ANTHROPIC_API_KEY` is a placeholder in both — needs a real value.

See `docs/ops/ENV-VARS.md` for the canonical key inventory.
