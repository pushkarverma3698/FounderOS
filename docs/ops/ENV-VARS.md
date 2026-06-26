# Environment Variables — Canonical Inventory

**No secret values live in this file.** It documents what each key is for, where the
truth lives, and rotation cadence. Source of truth for prod = the live box `.env` at
`/opt/founderos/.env`, rendered on each deploy from the base64 `PROD_DOTENV` GitHub
secret. GitHub secrets are **write-only** (cannot be read back) — the box is the only
readable source. Local dev `.env` is kept in sync with prod for real secrets; only
the model/runtime keys intentionally differ.

> Reconciled 2026-06-25: local `.env` matches the box for every real secret. See
> `docs/RELEASE-READINESS-AUDIT-2026-06-25.md`.

## Model / runtime (intentionally DIFFER dev vs prod)
| Key | Purpose | Dev | Prod |
|---|---|---|---|
| `NODE_ENV` | runtime mode | `development` | `production` |
| `AGENT_MODEL` | primary LLM | `openrouter:google/gemini-2.5-flash:free` | `openrouter:google/gemini-2.5-flash` (paid) |
| `AGENT_FALLBACK_MODELS` | 503 fallback chain | free models | per deploy.yml |
| `AGENT_TEMPERATURE` | determinism (rule #16) | `0` | `0` |
| `BUDGET_DAILY_USD` / `RUN_BUDGET_USD` / `RUN_BUDGET_TOKENS` | cost guards | same | same |

## Core API keys (SAME dev + prod — rotate together)
| Key | Service | Rotation |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter LLM gateway | rotate if leaked; was in the `.zshrc` leak set — confirm rotated |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google GenAI (legacy direct path) | as needed |
| `ANTHROPIC_API_KEY` | Claude-judge gate (rule #21) | ⚠️ **PLACEHOLDER in both — needs a real key** |
| `GITHUB_TOKEN` | engineering dept github_r/w | rotate per GitHub PAT expiry |
| `COMPOSIO_API_KEY` | Composio (gmail/calendar/linkedin) | see email gap below |
| `FIRECRAWL_API_KEY` | web search/scrape | as needed |

## Email / calendar (currently DOWN in prod — see audit)
| Key | Purpose | Status |
|---|---|---|
| `GMAIL_BACKEND` / `CALENDAR_BACKEND` | `gws` | backend selected |
| `GWS_BIN` | path to Google Workspace CLI | ⚠️ **EMPTY in prod** → gws "file cannot be empty" |
| `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` | gws OAuth creds file | missing on box |
| `COMPOSIO_ENTITY_GMAIL` / `COMPOSIO_ENTITY_LINKEDIN` | Composio entity IDs | set (`turicks-work` / `turicks-internal`) |

## LinkedIn
| Key | Purpose | Status |
|---|---|---|
| `LINKEDIN_BACKEND` / `LINKEDIN_API_VERSION` / `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | LinkedIn direct API | set |
| `LINKEDIN_ACCESS_TOKEN` / `LINKEDIN_AUTHOR_URN` | personal LinkedIn | **expires 2026-08-24** — re-auth before then |
| `LINKEDIN_ACCESS_TOKEN_TURICKS` / `_AUTHOR_URN_TURICKS` | Turicks page | ⚠️ `PENDING_LINKEDIN_APP_VERIFICATION` |

## Telegram
| Key | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | the bot + founder chat |
| `TELEGRAM_TESTER_API_ID` / `_API_HASH` / `_SESSION` | MTProto QA harness (founder-as-user) |

## Data / infra
| Key | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Postgres | password = `founderos`; deploy.sh self-heals the role password from this |
| `OLLAMA_URL` / `EMBED_MODEL` / `EMBED_DIM` / `RAG_BACKEND` | local embeddings (nomic-embed-text, 768d, pgvector) | RAG never leaves the box |
| `LANGCHAIN_API_KEY` / `LANGCHAIN_PROJECT` / `LANGCHAIN_TRACING_V2` | LangSmith telemetry | tracing off by default |
| `WEB_GATEWAY_TOKEN` | JARVIS web SSE auth | **prod-only** (empty local) |
| `STATIC_SITE_HOME_ROOT` / `STATIC_SITE_PUBLIC_BASE_URL` | static showcase serving | **prod-only** |
| `LOG_LEVEL` | log verbosity | prod-only (`info`) |
| `REDIS_URL` / `MEM0_API_KEY` | reserved (SaaS phase) | empty |
| `DAILY_SEND_LIMIT` / `FOUNDER_TENANT` / `BROWSER_BACKEND` | send ceiling / tenant / browser | set |

## Rules
- **Never commit `.env` or `.env.prod`** (both gitignored; `.env.prod` is untracked — keep it so).
- To change a prod secret: update the value, re-encode `PROD_DOTENV` (`base64 -w0 .env`, no newlines), set the GitHub secret, redeploy. Verify on-box `.env` afterward.
- Rotate immediately on any leak; the OpenRouter/OpenAI/gateway keys were exposed in a past `.zshrc` read — confirm rotation.
