# Production Deploy: DB Consolidation + Claude Executor Auth

**Date:** 2026-06-13
**Status:** Design — pending implementation plan
**Related:** ADR-013/015 (RAG store isolation), ADR-019 (Claude Code executor), `docs/guides/DEPLOYMENT.md`, branch `feat/deploy-vps-ci`

## Problem

Two coupled production-readiness questions surfaced while planning the VPS deploy:

1. **How does the Claude Code executor authenticate on a headless server?**
2. **Database sprawl:** the system reads from three stores — Postgres
   (`search_knowledge`, keyword only), and two ChromaDB services (`personal-rag`
   :8765, `turicks-brain` :8766), each requiring a Python FastAPI process **and**
   a shared Ollama server for embeddings. That is one database plus a search
   engine plus a model server to operate, patch, back up, and keep alive — an
   operational surface that has already failed in prod (`search_turicks_brain`
   was down).

Additional hard requirement: **all databases must always be private** (never
exposed to the public internet).

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Executor auth | **OAuth now + API-key fallback** | Use existing Max plan flat-rate via `claude login`; keep `CLAUDE_EXECUTOR_API_KEY` ready (commented in `.env`) for an instant switch if quota/ToS bites. Logic already exists in `buildExecutorEnv` (`src/tools/claude-code.ts`). |
| Storage | **Consolidate all 3 stores into one Postgres + pgvector** | "Separate store" (ADR-013/015) is a *boundary* concern, not an *engine* concern — isolation is preserved with separate tables + a code guard. Eliminates 2 Python services + ChromaDB. One engine, one backup, one thing to secure. |
| Embeddings | **Local Ollama `nomic-embed-text` only** (no API egress of RAG text) | Privacy: RAG corpus text never leaves the box. Same model Chroma already uses → identical 768-dim vectors → existing vectors can be migrated directly, no re-embed required and no quality change. |
| Host | **Hetzner CX32 (4 vCPU / 8 GB / 80 GB, ~€7.5/mo)** | Node + `claude` subprocess + Postgres + Ollama coexist comfortably (~3.5 GB used). CX22 (4 GB) is too tight once an executor build spikes. |

## Target topology

```
Hetzner CX32 host
├─ systemd:  founderos app (native)        ← needs `claude` CLI on PATH
├─ claude CLI (host install, dual auth: OAuth + API-key fallback)
└─ docker compose (deploy/stack.compose.yml):
     ├─ postgres + pgvector   →127.0.0.1:5432   ← THE one database
     │     ├─ knowledge_entries  (turicks; keyword ILIKE + vector)
     │     ├─ personal_rag        (isolated table; vector)
     │     └─ turicks_brain       (isolated table; vector)
     └─ ollama                (compose-internal :11434; nomic-embed-text; embeddings ONLY)
```

App stays native because the executor spawns the host `claude` binary using
stored OAuth creds in `~/.claude` — not cleanly containerizable. Everything
stateful goes in Docker. Ollama is reachable only on the compose network; the
host app reaches Postgres on loopback.

## Components & changes

### 1. Executor auth (dual mode)
- Install `claude` CLI as the `founderos` user; `claude login` once (paste-URL
  OAuth flow works headless) → creds in `~/.claude`.
- `.env`: `CLAUDE_EXECUTOR_API_KEY` present but **commented out**. `buildExecutorEnv`
  prefers the API key when set, else falls back to stored OAuth — flipping is a
  one-line `.env` change + `systemctl restart founderos`, zero code change.
- Spend guardrails already exist: HITL gate per task + wall-clock `TIMEOUT_MS`.
  Document the switch + a budget note in the runbook.

### 2. Postgres + pgvector
- Postgres image gains the `vector` extension (`pgvector/pgvector:pg16` or
  `CREATE EXTENSION vector` in init).
- New tables `personal_rag` and `turicks_brain`: `(id, content, metadata jsonb,
  embedding vector(768), created_at)`. `knowledge_entries` gains an optional
  `embedding vector(768)` column for hybrid keyword+vector search.
- **Isolation guard:** a single code-level access layer ensures the
  personal-rag tool can only read `personal_rag` and the turicks tool only
  `turicks_brain` — the ADR-013/015 cross-write ban, enforced in code.

### 3. Migration (one-time)
- Stand up Ollama + pull `nomic-embed-text` (same model Chroma used).
- **Export existing Chroma vectors** (`personal-rag`, `turicks-brain-rag` persist
  dirs) → bulk-insert into the new pgvector tables. Vectors are identical model
  output, so no re-embedding needed. If export proves impractical, fall back to
  re-ingesting from source docs (`scripts/ingest_local_docs.py`, `brain:sync`).
- Verify parity: a fixed set of queries returns equivalent top-k before/after.

### 4. Rewrite the two search tools
- `src/tools/rag.ts`: replace the HTTP calls to ChromaDB (:8765/:8766) with
  Postgres pgvector nearest-neighbour queries (`embedding <=> $queryEmbedding`),
  embedding the query via local Ollama. Same tool names, same input/output
  contract → no change to agents, prompts, or the office graph.
- Delete Chroma/FastAPI client code paths once parity is verified.

### 5. Deploy + privacy
- `deploy/stack.compose.yml` (supersedes `deploy/postgres.compose.yml`): postgres
  + ollama only. **All ports bound to `127.0.0.1`**; Ollama published to no host
  port at all. `ufw` allows SSH only.
- `deploy/deploy.sh`: bring up the stack, wait for Postgres health, run
  migrations, restart the app, verify `/health`.
- `deploy/backup-db.sh`: single `pg_dump` stream → gzip → (recommended) gpg
  encrypt → off-box sync. One backup covers all three logical stores.

## Out of scope / deferred
- **Hosting the Python RAG services / Chroma in prod** — eliminated by this design.
- **API-based embeddings (Gemini)** — rejected for privacy (RAG text must stay local).
- **Multi-tenant pgvector partitioning** — Phase E (SaaS) concern, not now.

## Success criteria
- One Postgres engine serves all three knowledge stores; no Chroma, no Python
  RAG service, no Ollama host port in production.
- `search_knowledge`, `search_personal_rag`, `search_turicks_brain` all return
  results with unchanged tool contracts; top-k parity verified vs the old Chroma
  stores.
- Personal-rag tool cannot read turicks data and vice-versa (guard test).
- All DB ports bound to loopback; `ufw` SSH-only; encrypted off-box backup runs.
- Executor works via OAuth on the server; flipping to API key is a `.env` +
  restart with no code change.
- `pnpm test` green; live Telegram path exercises a RAG query end-to-end.
