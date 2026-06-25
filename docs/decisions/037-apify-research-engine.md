# ADR-037 — Apify as the Research Department's Real-Data Engine + Research Memory

**Status:** Accepted · **Date:** 2026-06-24 · **Phase:** D (Revenue Flywheel)

## Context
The `research` department could only *search* the web (Gemini grounding → DuckDuckGo
fallback) — it saw titles + ~300-char snippets, never full page content. There was no
page-level scraping, no durable memory of what it found, and no dedup. The founder wants
best-in-class research: a real scraper feeding real data into the best memory, working
identically on the local Mac, the Hetzner VPS, and the FounderOS app.

We evaluated the 2026 scraper landscape (Firecrawl, Jina, Bright Data, ScrapeGraphAI) and
chose **Apify** (https://apify.com): the largest actor marketplace, a clean REST API, an
official client, and — decisively — `apify/rag-web-browser`, an actor purpose-built to feed
RAG/agent pipelines (query OR url → real-browser scrape → clean Markdown + metadata).

## Decision
1. **Apify scrape engine** (`src/tools/apify.ts`) — one `runActorSync` helper
   (`POST /v2/acts/{actor}/run-sync-get-dataset-items`, Bearer auth) behind typed wrappers
   `ragWebBrowser` + `websiteContentCrawler`. Fail-open exactly like `web-search.ts`: if
   `APIFY_TOKEN` is unset or Apify errors, fall back to a keyless in-process `fetch` →
   strip-to-markdown (reusing the exported `stripHtml`). The tool never hard-fails — the
   lesson from the removed Firecrawl integration (402 once credits ran out).
2. **Three read-only research tools** (no HITL — gates guard sends, not reads):
   `scrape_url` (one URL → full Markdown), `deep_research` (query → top-N full pages +
   synthesis, always cited; hard cap 3 pages/turn), `crawl_site` (site/docs → bulk ingest).
   Wired through the standard 6-layer map (capabilities → office caps → prompts → graph).
3. **Research memory** (`src/infra/research-memory.ts` + new `brain.research_cache`
   pgvector table, migration `0009`): every scrape is (a) cached in Redis keyed by url/query
   hash (dedup, `RESEARCH_CACHE_TTL_SECONDS`, default 24h), (b) chunked + embedded via local
   Ollama and upserted (idempotent per `source_url`), and (c) queryable via
   `search_research_cache`. Citations (`source_url`, `title`, `retrieved_at`) are first-class
   in row metadata. `deep_research`/`crawl_site` also log a non-HITL episodic event so the
   team builds on prior runs.
4. **Native tool, not MCP.** Apify ships an MCP server, but the repo's tool model is native
   (MCP is reserved for Gmail/Drive/GitHub); native gives deterministic routing + budget
   control (rules #16, #23).
5. **Store boundary.** `research_cache` holds business-public web findings — it sits on the
   `turicks_brain` side of the ADR-013/015 firewall, never crossing into `personal_rag`.

## Global rollout
Hosted Apify API + one token = identical path everywhere. Set `APIFY_TOKEN` in local `.env`,
VPS `PROD_DOTENV`, and the app — no per-environment branching. Embeddings already run on
local Ollama on every box. `SCRAPE_BACKEND=fetch` forces the keyless path (offline/dev).

## Consequences
- **Positive:** real full-page data; durable, citeable, dedup'd research memory; degrades to
  free `fetch` when Apify is absent; zero new runtime deps (raw `fetch`).
- **Costs:** Apify is paid per result — mitigated by the Redis cache, the 3-page `deep_research`
  cap, and the `SEARCH_TOOL_LIMITS` per-turn caps.
- **Provisioning (rule #22):** `research_cache` needs migration `0009` applied
  (`pnpm db:migrate`) and Ollama up for ingestion; absent Ollama, scrapes still return to the
  founder (ingest is fail-open, logs the real failing component).

## Verification
- `pnpm lint` clean; `pnpm test` 1394 passing (33 new: apify engine, research-memory,
  research tools); `pnpm verify:wiring` 0 warnings; `pnpm graph:gen` shows the 4 new tools.
- **Pending live (needs APIFY_TOKEN + DB/Ollama):** one real `scrape_url` → cache row →
  `research_cache` row → retrieval score; one MTProto `deep_research` real-path QA.
