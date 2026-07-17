# Brain 2.0 — Deep Research: Making the FounderOS RAG & Brain LLM-Native and Self-Feeding

**Status:** Research / RFC (not yet an accepted ADR)
**Date:** 2026-07-14
**Author:** Research pass (agent-assisted), commissioned by Pushkar
**Branch:** `claude/founderos-rag-research-0d1mya` (off `main`, per directive — do not merge without review)
**Scope:** How to (1) make the RAG/brain retrieval *LLM-optimised and easy to retrieve*, (2) auto-ingest our Claude chats every day, and (3) turn the brain into the thing that makes the **planner/supervisor/router and workers measurably smarter** — especially alongside the sandboxed worker-node work landing on `claude/founderos-antigravity-vwnrks`.

> This document is deliberately **grounded in the code that exists today** (file paths and line references are real as of this branch). It is not a generic RAG tutorial. Every proposal is checked against the non-negotiable invariants in `CLAUDE.md`: determinism at temp 0, ADR-013/015 store isolation, fail-loud/fail-open discipline, contract-first boundaries, the 400-LOC file budget, and "evidence over assertion" (rule #24).

---

## 0. TL;DR — the five moves

1. **Contextual Retrieval + hybrid + rerank.** Our biggest, cheapest win. Prepend an LLM-written context blurb to every chunk before embedding, run **BM25 keyword + pgvector dense in parallel**, fuse with Reciprocal Rank Fusion, then **rerank** the top ~20 down to the top ~5. Anthropic's own numbers: −49% retrieval failures from contextual embeddings, **−67% when combined with reranking**. We already have both a keyword path (`searchKnowledgeEntries`) and a dense path (`searchRagTable`) — they just don't talk to each other yet.
2. **Daily Claude-chat ingestion.** Claude Code writes every session to `~/.claude/projects/<slug>/<session>.jsonl` and a global `~/.claude/history.jsonl`. A nightly job distills each new session into a structured "session memory card" and ingests it into `turicks_brain` (business) — never into `personal_rag` (ADR-013/015 firewall). This closes ADR-016's original directive: *"Everything I do with the assistant must also be done with FounderOS."*
3. **A retrieval CONTRACT, not a free-text tool.** Give the kernel a typed `BrainQuery → BrainEvidence[]` contract (cited, scored, deduped, token-budgeted) so retrieval becomes a first-class, testable kernel boundary like everything else — not three loosely-related agent tools returning prose blobs.
4. **Brain-in-the-loop planning.** The planner and supervisor are currently *blind* — they route on the raw message plus a static worker catalog. Let them pull a tiny, cheap "context brief" (decisions, precedents, entities, prior failures for this task-shape) *before* routing. This is where "smarter router/supervisor" actually comes from.
5. **Memory consolidation, not memory accumulation.** Raw logs rot. Add a nightly consolidation pass that promotes recurring facts to durable `knowledge_entries`, decays stale chunks, and prunes orphans — so the brain gets *sharper* over time, not just bigger.

---

## 1. Ground truth — what the FounderOS brain is TODAY

FounderOS already has a real, multi-store memory system. Any improvement has to respect it, so here is the exact inventory.

### 1.1 The stores (5 of them, 2 hard-isolated)

| Store | Table / backend | Written by | Read by | Search type |
|---|---|---|---|---|
| **turicks-brain** | `turicks_brain` (pgvector, 768-d) + `knowledge_entries` (keyword + doc-embedding) | `scripts/sync-turicks-brain.ts` (`pnpm brain:sync`) | `search_turicks_brain`, `search_memory` | dense (pgvector) *or* keyword (ILIKE) — **separately** |
| **personal-rag** | `personal_rag` (pgvector, 768-d) | `scripts/sync-personal-rag.ts` | `search_personal_rag` | dense |
| **research-cache** | `research_cache` (pgvector, 768-d) | `src/infra/research-memory.ts` (auto after every scrape) | `search_research_cache` | dense |
| **episodic** | `episodic_memory` | `record_event` (HITL-gated) + mem0 push | `search_memory` (`episodic`) | keyword ILIKE + recency (+ mem0 semantic if key set) |
| **founder_context** | `founder_context` (JSONB, ~21 keys) | manual / seed scripts | `search_memory` (`context`), `read_context` | text-contains |

**The firewall (ADR-013 / ADR-015):** `personal_rag` (career/CV/salary/identity) and `turicks_brain` (business/ADRs/strategy) are **separate stores that never cross-write**. `research_cache` sits on the business side. `src/db/rag-search.ts:12` hard-allowlists the three legal RAG table names and refuses anything else — this is both an SQL-injection guard and the architectural firewall. **Every proposal below preserves this. It is not negotiable.**

### 1.2 The retrieval path (as-is)

```
agent tool (search_turicks_brain)              [src/tools/rag.ts]
  └─ runRagSearch(table, query, topK)
       ├─ RAGFlow backend?  → RAGFlow /retrieval  (opt-in, RAG_BACKEND=ragflow)
       └─ pgvector backend (default):
            ├─ embedText(query)                  [src/lib/embed.ts → Ollama nomic-embed-text, 768-d, on-box]
            └─ searchRagTable(table, vec, topK)  [src/db/rag-search.ts → 1 - cosine_distance, HNSW index]
```

Key properties already in place (these are strengths, keep them):
- **Privacy by construction.** Embeddings are generated locally via Ollama (`nomic-embed-text`); RAG text never leaves the box (`src/lib/embed.ts:1-4`). Any new embedding/rerank step must keep this property or be explicitly flagged as egress.
- **Chunking exists.** `chunkText()` (`src/lib/embed.ts:47`) does ~1800-char overlapping chunks on paragraph/sentence boundaries. Reasonable, but naïve (fixed-size, no structural awareness) — see §3.1.
- **Stage-tagged failures.** `runRagSearch` distinguishes `embed` (Ollama) vs `query` (Postgres) failures (`src/tools/rag.ts:36`) so we never again mislabel a DB outage as "Ollama down" (the bug that cost a prod debugging session, rule #22). New retrieval stages must keep naming the real failing component.
- **Idempotent sync.** `brain:sync` deletes-then-reinserts chunks per `source_path` (`scripts/sync-turicks-brain.ts:288`); research ingest does the same per `source_url`. Re-runs refresh, never duplicate. Any new ingester must follow this pattern.
- **Hybrid column already provisioned.** `knowledge_entries.embedding VECTOR(768)` exists (`drizzle/0005_pgvector.sql`) and `brain:sync` populates a doc-level embedding — but **nothing queries it hybrid-style yet.** The plumbing for hybrid search is half-built and abandoned. Low-hanging fruit.

### 1.3 How the "brain" reaches the intelligence layer (as-is)

This is the crux of the user's request, so be precise about the current wiring:

- **The planner (`src/kernel/planner.ts`) does NOT touch the brain.** It gets: the founder's message, a static worker catalog (id + description + tool names), and a truncated conversation history. That's it. It routes blind. The only "knowledge" it has about *how to route this kind of task* is baked into `buildPlannerPrompt` as static English (`planner.ts:56-85`).
- **The supervisor (`src/kernel/supervisor.ts`) is pure code** — it advances the cursor and shuttles envelopes. It has zero knowledge input by design.
- **Only workers touch the brain,** and only if the planner happened to route to a worker whose tool list includes `search_turicks_brain` / `search_memory` / `search_personal_rag` / `search_research_cache`. The worker runs in an **isolated envelope-only context** (`src/kernel/worker.ts:1-17`) — it sees its one objective and nothing else. This isolation *is* the "sandboxing" the antigravity branch hardens (isolated records, tool-output guards, self-healing retries — see `git diff origin/main origin/claude/founderos-antigravity-vwnrks`).

**The insight:** today the brain is a *worker-level lookup tool*. To make the **router/supervisor** smarter, the brain has to become a *planning-time input*, not just an execution-time tool. That reframing is the spine of Part 5.

---

## 2. Gap analysis — where retrieval is leaving intelligence on the table

Concrete, code-level gaps (not vibes):

1. **No hybrid search.** Dense-only retrieval misses exact-match queries (a person's name, an error code, "ADR-032", a €amount). Keyword-only (`searchKnowledgeEntries`) misses paraphrases. We have both engines and fuse *neither*. This is the single most common production RAG failure mode and we're fully exposed to it.
2. **No reranking.** `searchRagTable` returns the top-k by raw cosine distance and stops. Cosine top-5 ≠ relevance top-5. A cross-encoder rerank over the top-20 is the highest-ROI accuracy lever after hybrid.
3. **Context-blind chunks.** A chunk reading *"It was reduced by 30% in Q2"* embeds with no idea what "it" is or which entity. Anthropic's Contextual Retrieval fixes exactly this by prepending a one-line LLM-written context header before embedding. Our chunker (`embed.ts:47`) is purely positional.
4. **Metadata is carried but never used for filtering.** Every chunk stores `entry_type`, `tags`, `source_path`, `chunk_index` (`sync-turicks-brain.ts:301`) and the tools *advertise* a `doc_type` filter (`rag.ts:132`) — but `searchRagTable` **ignores it entirely** (`rag-search.ts:32-57` has no WHERE on metadata). So "search only decisions" silently searches everything. Dead parameter.
5. **Retrieval returns prose, not evidence.** Tools return a formatted string (`formatResults`, `rag.ts:85`). The synthesizer/worker can't reason over structured citations, dedupe overlapping chunks, or enforce a token budget. There is no `Evidence` type in `contracts.ts`. Retrieval is the one major kernel boundary that *isn't* a contract.
6. **The brain is fed by hand.** `brain:sync` only ingests `docs/**` markdown. The actual daily reasoning — every Claude Code session where real decisions get made — **evaporates.** ADR-016 explicitly named this the original problem ("knowledge produced while working *with the assistant* lived only in chat history — ephemeral, unqueryable, lost") and it's *still* unsolved. This is the user's core ask.
7. **No relationships between facts.** Everything is a flat chunk. "Which decisions depend on ADR-032?" / "what did we try last time a GitHub-write task failed?" are graph questions a flat vector store can't answer. No entity or edge layer.
8. **No feedback signal.** We never record which retrieved chunk actually helped a turn succeed. So retrieval quality can't improve automatically and we can't eval it. There's no golden retrieval set.
9. **Memory only grows.** No decay, no consolidation, no promotion of "seen 5 times" facts into durable knowledge. Left alone, the store fills with near-dup chunks and retrieval precision *degrades* as volume climbs.
10. **Planner/supervisor can't learn task-shape lessons.** There's a `lesson_candidate` channel in state (`planner.ts:199`) but lessons aren't retrieved at plan time to bias routing. The system re-derives routing from scratch every turn.

---

## 3. The techniques — deep dive, mapped to our stack

### 3.1 Contextual Retrieval (the flagship win)

**Problem it solves:** isolated chunks lose the document's framing. **The method (Anthropic, validated):** before embedding a chunk, ask a cheap LLM to write 1–2 sentences situating that chunk within its parent document, and prepend them. Embed and BM25-index the *contextualized* chunk. Reported: **−49% top-20 retrieval failures**, **−67% with reranking added.**

**How it lands here — a surgical change to `syncVectorChunks` (`sync-turicks-brain.ts:288`):**

```
for each chunk:
  context = await cheapModel.invoke(
    CONTEXTUALIZE_PROMPT(fullDoc.slice(0, N), chunk))   // "This chunk is from ADR-032 ... it argues ..."
  embedInput = `${context}\n\n${chunk}`
  embedding = embedText(embedInput)                      // context-aware vector
  store(content: chunk, context, embedding)              // keep raw chunk for display; store context in metadata
```

- **Cost control:** run the contextualizer with a **free OpenRouter model** (per the founder's no-paid-fallback directive in `CLAUDE.md`) or a local Ollama chat model, temp 0, cached by chunk hash so re-syncs are free. This keeps "zero paid calls in the dev loop" intact.
- **Determinism:** temp 0 + a hash cache means the same doc yields the same contexts across CI runs — preserves the "golden set twice, identical" rule.
- **Store the raw chunk for display, the contextualized text for the vector.** Display citations from the raw chunk (rule #24 verifiability), retrieve on the enriched vector.

This is the **first thing to build** — it upgrades every downstream retrieval for one localized change to the ingest path.

### 3.2 Hybrid search (BM25 + dense) with Reciprocal Rank Fusion

**Postgres does both natively** — no new infra:
- **Dense:** already have it (`searchRagTable`, HNSW cosine).
- **Sparse/keyword:** Postgres full-text (`tsvector` / `ts_rank_cd`) or the `pg_bm25`/`ParadeDB` extension for true BM25. Start with built-in `tsvector` (zero new deps) and upgrade to `pg_bm25` only if precision demands it.

**Fusion:** run both, then Reciprocal Rank Fusion — `score(d) = Σ 1/(k + rank_i(d))`, k≈60. RRF is score-scale-agnostic (no fragile min-max normalization) and deterministic. Return the fused top-N to the reranker.

```
hybridSearch(table, query, k):
  dense  = searchRagTable(table, embed(query), 20)        // existing
  sparse = searchBm25(table, query, 20)                   // new: tsvector/pg_bm25
  fused  = rrf(dense, sparse, k=60)                        // pure fn, unit-testable
  return fused.slice(0, k)
```

Pure fusion function = trivially unit-tested at $0, deterministic. Fits the kernel's testing model.

### 3.3 Reranking

Take the fused top-20 → cross-encoder rerank → top-5. Options, in order of privacy preference:
- **On-box (preferred):** a small cross-encoder (e.g. `bge-reranker-base`/`v2-m3`) served locally, same "no egress" property as Ollama embeddings. ~100–300ms for 20 candidates on CPU; acceptable for a Telegram turn.
- **RAGFlow already reranks.** If we ever flip `RAG_BACKEND=ragflow`, reranking + hybrid come for free (`src/infra/ragflow.ts` already sends `vector_similarity_weight`). Worth reconsidering RAGFlow as the managed backend if we don't want to hand-roll rerank.
- **Cohere Rerank / Voyage** — cloud, breaks the on-box privacy property. Only for the business-side stores (`turicks_brain`, `research_cache`), **never** `personal_rag`. Prefer to avoid.

Reranking is optional/flagged — degrade gracefully to fused order if the reranker is down (fail-open, but log the real component per rule #22).

### 3.4 GraphRAG / entity layer (phase 3, higher effort)

Flat chunks can't answer relational questions. A lightweight knowledge graph over the business store unlocks:
- Entities: decisions (ADRs), clients (Naggar, Turicks), people, features, failures.
- Edges: `ADR-041 supersedes ADR-xx`, `client → deal → amount`, `task-shape → prior failure → fix`.

**Pragmatic version (no Neo4j):** extract `(subject, predicate, object)` triples during ingestion with the same cheap LLM, store in a `brain_edges` table (Postgres), and at query time expand retrieved chunks by 1 hop. This is "GraphRAG-lite" — 80% of the value, none of the graph-DB ops burden. Defer full GraphRAG until flat+hybrid+rerank plateau.

### 3.5 Agentic RAG (query planning over retrieval)

Instead of one-shot "embed the raw message and search," an agentic retriever:
1. **Rewrites/decomposes** the query (resolve "it"/"that", split multi-part questions).
2. **Routes** to the right store(s) — respecting the firewall (career → personal_rag; business → turicks_brain; web facts → research_cache).
3. **Retrieves + reranks**, and if confidence is low, **reformulates and retries** once.
4. Returns cited evidence.

**Important scoping vs. our determinism rule:** routing/decomposition that affects *which tools run* must stay in the deterministic planner (temp 0, unit-tested), **not** be a free-wheeling agent loop. Agentic RAG here means "a small, bounded, temp-0 retrieval sub-contract," not "let the model wander." This keeps CLAUDE.md rule #16 (routing is pure, never prompt-instructed) intact.

### 3.6 Memory consolidation & decay

Nightly maintenance pass (fits `src/infra/scheduler.ts`, which is "maintenance only"):
- **Consolidate:** cluster near-duplicate chunks; if a fact recurs across ≥N sessions, promote it to a durable `knowledge_entries` row (versioned, like `brain:sync` already does).
- **Decay:** add a `last_used_at` / `hit_count` to chunks; down-weight or archive chunks never retrieved in 90 days (except pinned ADRs).
- **Prune orphans:** there's already a branch `fix/brain-sync-orphan-prune` — align with it. Delete chunks whose `source_path` no longer exists.

Consolidation is what makes the brain get *smarter with age* instead of noisier.

---

## 4. Feeding the brain from Claude chats — the daily pipeline (the core ask)

### 4.1 Where the data actually lives (verified)

Claude Code persists every session locally:
- `~/.claude/projects/<project-slug>/<session-id>.jsonl` — full transcript, one JSON object per line (message / tool_use / metadata).
- `~/.claude/projects/<project-slug>/sessions-index.json` — summaries, message counts, git branch, timestamps.
- `~/.claude/history.jsonl` — global index (prompt text, timestamp, project path, session id).
- `/export` (in-session) — clean text/markdown dump; `claude.ai` also has a full **account data export** (Settings → Export) for web/desktop chats.

**Caveat (from Anthropic docs):** the raw JSONL schema is *internal and changes between Claude Code versions*. So: parse defensively, pin to the fields we need (`role`, `content`, `timestamp`, tool names), and treat unknown shapes as skip-with-log, never crash. Prefer `sessions-index.json` for metadata over re-deriving it.

### 4.2 The pipeline: `scripts/ingest-claude-sessions.ts` (new, → `pnpm brain:ingest-chats`)

```
nightly (scheduler or cron on the VPS):
  1. Scan ~/.claude/projects/**/<session>.jsonl and ~/.claude/history.jsonl
     └─ dedupe against a `chat_ingest_log` table (key = session_id + last_line_hash)
        → only NEW or GROWN sessions are processed (idempotent, incremental).
  2. For each new/updated session:
     a. Parse defensively → ordered turns (user msg, assistant reply, tool calls/results).
     b. DISTILL with a cheap temp-0 model into a structured "Session Memory Card":
          { title, date, project, branch,
            decisions[]        // "chose X over Y because Z"
            outcomes[]         // "shipped Phase D", "fixed RAG mislabel bug"
            open_questions[],
            entities[],        // ADRs, clients, files touched
            do_not_repeat[] }  // failures + their fix  ← feeds planner lessons
     c. CLASSIFY each card business-vs-personal.  ← THE FIREWALL GATE
          business → turicks_brain (+ knowledge_entries if it's a real decision)
          personal → personal_rag  (career/identity only)
          ambiguous → quarantine table for human review; NEVER auto-cross-write.
     d. Contextualize (§3.1) + chunk + embed on-box (Ollama) → ingest idempotently
        (delete-then-insert per session_id, same pattern as research-memory.ts).
  3. Significant decisions → also insert an episodic_memory row (mirrors record_event),
     so "what did we decide on 2026-07-14?" works via search_memory too.
  4. Emit a one-line summary to the founder via Telegram (optional): "Ingested 3 sessions,
     6 decisions, 1 do-not-repeat lesson."
```

**Why distill instead of dumping raw transcripts?**
- Raw transcripts are 90% noise (tool JSON, retries, thinking). Embedding them pollutes retrieval.
- A distilled card is dense, LLM-optimised, and cites its source session — exactly the "easy to retrieve, LLM-optimised" property the founder asked for.
- Distillation is where **do-not-repeat lessons** get extracted — the payload that makes the *router* smarter (§5).

**Privacy/firewall discipline (non-negotiable):**
- The business/personal classifier gates every card. Default-deny on ambiguity → quarantine, human review. This is the ADR-013/015 firewall applied to a new source. A misclassification that leaks salary data into `turicks_brain` would be a serious violation, so the classifier fails *closed* (to quarantine), never *open* (to a guessed store).
- All embedding stays on-box (Ollama) — chat content never egresses for the personal side. For the business side, distillation with a free OpenRouter model sends *business* text only, and only if `RAG_BACKEND`/distiller is a remote model; prefer a local Ollama chat model for the distiller to keep everything on-box.

**Deliverables for this piece:**
- `drizzle/00xx_chat_ingest.sql` — `chat_ingest_log` (dedupe/incremental) + `chat_quarantine`.
- `src/infra/claude-session-parser.ts` — defensive JSONL → turns (LOC-budgeted, <400).
- `src/infra/session-distiller.ts` — turns → Session Memory Card (typed, Zod).
- `scripts/ingest-claude-sessions.ts` — the runner (`pnpm brain:ingest-chats`), fail-loud on Ollama down (mirror `brain:sync`'s connectivity probe, `sync-turicks-brain.ts:332`).
- Scheduler entry / VPS cron. Because sessions live under `~/.claude`, this runs where Claude Code runs (the founder's machine) or ships exports to the VPS — decide per deployment (open question §8).

### 4.3 Real-time option (later)

Beyond nightly, a Claude Code **`Stop` / `SessionEnd` hook** (`.claude/settings.json`) could fire the distiller at the end of *every* session, making ingestion near-real-time instead of nightly. Nightly first (simpler, batchable); hook-driven as a fast-follow.

---

## 5. Making the router / supervisor / workers smarter (the actual goal)

Retrieval quality is a means; the end is a **more intelligent orchestration layer**. Here's the mapping, tied to the sandboxed worker-node architecture.

### 5.1 Brain-in-the-loop planning (the big one)

Today the planner routes blind (§1.3). Give it a **cheap, bounded, temp-0 "context brief"** *before* it produces the plan:

```
plan(state):
  brief = await getPlanningBrief(state.turn.raw_input)   // NEW, bounded, cacheable
     ├─ top-3 relevant DECISIONS (turicks_brain, doc_type=decision)
     ├─ top-2 DO-NOT-REPEAT lessons for this task-shape (from §4 distillation)
     └─ known ENTITIES in the message (client names, ADRs, files)
  decision = model.invoke([systemPrompt, briefAsContext, history, input])
```

Effect:
- The router stops re-deriving "GitHub questions go to engineering" from static English and instead sees *"last time a github-write task on this repo failed because X; the fix was Y."* That's the difference between a router that repeats mistakes and one that doesn't.
- **Determinism preserved:** the brief is retrieved deterministically (temp 0, fixed top-k, hybrid+rerank are pure given the store) and injected as *context*, not as a routing instruction. The planner still emits the same typed `PlannerDecision`, still validated by contract. The golden-set-twice-identical rule holds as long as the store is fixed during a run (freeze the store snapshot for CI).
- **Cost:** one extra retrieval per turn (no extra LLM call if we skip query-rewrite; +1 cheap call if we do). Cache by normalized message.

### 5.2 A retrieval CONTRACT (make the brain a kernel boundary)

Add to `src/kernel/contracts.ts`:

```ts
BrainQuery   = { intent, query, stores: RagStore[], filters?, top_k }   // typed, Zod
BrainEvidence = { chunk_id, content, source, score, store, retrieved_at } // cited, deduped
```

Then retrieval becomes a validated boundary like `StepResult`/`TaskEnvelope`: deduped, token-budgeted, every hit carrying a citation (rule #24). The synthesizer already "sees only validated results" — feed it `BrainEvidence[]`, so zero-hallucination extends to retrieval provenance. This also gives us a clean seam to **eval retrieval** (§6).

### 5.3 Worker-node synergy (the antigravity / sandboxing branch)

The antigravity branch adds isolated records, tool-output guards, self-healing retries, and dependency-aware parallel routing (see its diff). A smarter brain compounds with it:
- **Per-worker knowledge scoping.** Each sandboxed worker gets *only* the evidence relevant to its envelope — the isolation model already fits `BrainEvidence` injection into the envelope. A revenue worker never sees engineering ADRs it can't act on.
- **Dependency-aware routing + retrieved precedents.** If the planner can build a dependency DAG (antigravity) *and* retrieve "this multi-step shape usually needs a verify step," plans get structurally better, not just individually.
- **Self-healing + do-not-repeat lessons.** Antigravity retries on failure; the brain tells it *how* to retry differently (the `do_not_repeat[]` cards). Retry-with-memory >> blind retry.
- **Retrieval inside the sandbox stays on-box.** The worker's brain query hits local Ollama + local Postgres — no new egress from inside a sandboxed node. The isolation guarantee is preserved.

### 5.4 Feedback loop (closing it)

Record, per turn, which `chunk_id`s were retrieved and whether the turn *succeeded* (we already have `StepResult` ok/fail + receipts). That yields:
- A **retrieval-quality signal** → down/up-weight chunks (§3.6 decay uses it).
- A **golden retrieval eval** → add to the `pnpm eval` milestone gate: "for query Q, chunk C must appear in top-5." Now retrieval regressions fail CI like everything else.

---

## 6. Evaluation — so "smarter" is measured, not asserted (rule #24)

Nothing ships as "smarter" without a fresh command showing it. Proposed harness:
- **Retrieval golden set** (`src/eval/retrieval-golden.ts`): ~30 (query → must-retrieve chunk) pairs drawn from real decisions. Metrics: Recall@5, MRR, hybrid-vs-dense delta. Runs at $0 against a frozen store snapshot; deterministic.
- **End-to-end routing eval:** does brain-in-the-loop planning change routing on the golden tasks, and for the better? Diff plans with/without the brief.
- **Ingestion eval:** feed a canned Claude session fixture → assert the distilled card's decisions/lessons and that the firewall classifier routes correctly (and quarantines the planted ambiguous case).
- **Cost/latency budget:** contextual-ingest cost per doc, added turn latency from hybrid+rerank. Report in `docs/COSTS.md` via the existing `pnpm proof:costs`.

CLAUDE.md rule #24 applies verbatim: unit tests are necessary, not sufficient — exercise the real path (gateway → planner-with-brief → worker retrieval → reply) before claiming any of this works.

---

## 7. Phased roadmap (impact × effort)

| Phase | What | Impact | Effort | Preserves |
|---|---|---|---|---|
| **P0 — Hybrid + metadata filter** | Add BM25 (`tsvector`) path + RRF fusion; make `doc_type`/`tags` filters actually filter in `searchRagTable`. | High | **Low** (both engines exist) | determinism, firewall |
| **P1 — Reranking** | On-box cross-encoder over fused top-20 → top-5; fail-open to fused order. | High | Low–Med | on-box privacy |
| **P2 — Contextual Retrieval** | Contextualize chunks at ingest (cheap temp-0, hash-cached). Re-sync all stores. | **Very high** | Med | determinism, $0 dev loop |
| **P3 — Retrieval contract** | `BrainQuery`/`BrainEvidence` in `contracts.ts`; tools return typed evidence; synthesizer consumes it. | Med (unlocks evals) | Med | contract-first |
| **P4 — Claude-chat ingestion** | Parser + distiller + firewall classifier + nightly runner (`brain:ingest-chats`). | **Very high** (the ask) | Med–High | ADR-013/015 |
| **P5 — Brain-in-the-loop planning** | `getPlanningBrief` → planner/supervisor context; do-not-repeat lessons at route time. | **Very high** (smarter router) | Med | rule #16 determinism |
| **P6 — Consolidation & decay** | Nightly consolidate/promote/prune; `hit_count`/`last_used_at`; align with `fix/brain-sync-orphan-prune`. | Med (compounding) | Med | idempotent sync |
| **P7 — GraphRAG-lite** | Triple extraction → `brain_edges` → 1-hop expansion. | Med–High | High | — |
| **P8 — Retrieval eval gate** | Golden retrieval set into `pnpm eval`; feedback loop wired. | High (guards the rest) | Med | rule #24 |

**Recommended first cut (2–3 focused PRs):** P0 + P1 together (retrieval accuracy, no new infra, no new privacy surface), then P4 (the daily chat ingestion the founder explicitly wants), then P5 (turn that ingested knowledge into a smarter router). P2 slots in whenever we're ready to re-sync. Everything after is compounding polish.

---

## 8. Risks, invariants, and open questions

**Invariants preserved throughout (checklist for any PR that implements this):**
- [ ] ADR-013/015 firewall: no path writes personal data into a business store; classifier fails *closed* to quarantine.
- [ ] Determinism: retrieval is pure given a frozen store; routing stays temp-0 and contract-validated; golden set runs twice identical.
- [ ] On-box privacy: embeddings + reranker + personal-side distillation stay local (Ollama); any egress is explicit and business-only.
- [ ] Fail-loud vs fail-open in the right places: ingestion probes Ollama and aborts before partial writes (like `brain:sync`); retrieval degrades gracefully and names the real failing component (rule #22).
- [ ] Idempotent ingest: delete-then-insert per source key; incremental via `chat_ingest_log`.
- [ ] LOC budget: no file >400 lines; split parser/distiller/classifier.
- [ ] Evidence over assertion: nothing marked "done" without a fresh live-path run (rule #24).

**Risks:**
- *Distillation drift* — a bad distiller poisons the brain. Mitigate: temp 0, cite source session, spot-check via quarantine, retrieval eval gate.
- *Classifier leakage* — the single most serious risk. Default-deny + human-reviewed quarantine + never auto-cross-write.
- *Claude Code JSONL schema churn* — parse defensively, pin fields, skip-and-log unknowns, prefer `/export` and `sessions-index.json` where possible.
- *Latency creep* — hybrid+rerank adds 100–400ms/turn. Budget it; make rerank flag-gated; cache planning briefs.
- *Store growth* — mitigated by P6 consolidation/decay; without it, precision decays as volume rises.

**Open questions (need founder/architecture decisions):**
1. **Where does chat ingestion run?** Claude sessions live under `~/.claude` on the founder's dev machine; the brain (Postgres/Ollama) runs on the VPS (`/opt/founderos`). Do we (a) run the distiller locally and push cards to the VPS, (b) rsync `~/.claude/projects` to the VPS nightly, or (c) use a Claude Code `SessionEnd` hook that POSTs cards to a FounderOS ingest endpoint? (Leaning **c** long-term, **b**/local-distill short-term.)
2. **RAGFlow vs hand-rolled?** RAGFlow gives hybrid+rerank+chunking managed (`src/infra/ragflow.ts` already integrated, opt-in). Do we invest in RAGFlow as the backend, or keep the pgvector path and add hybrid/rerank ourselves (more control, on-box, more code)? Recommend: **hand-roll P0/P1 on pgvector** (keeps on-box privacy + determinism), keep RAGFlow as the escape hatch.
3. **Reranker model choice** — `bge-reranker-v2-m3` on-box vs a cloud reranker for business-only stores. Recommend on-box to preserve the privacy invariant uniformly.
4. **How aggressive is decay?** What's pinned forever (all ADRs?) vs eligible for archival?

---

## 9. Appendix — file/line index used for this research

- Stores/firewall: `src/db/rag-search.ts` (allowlist `:12`, search `:32-57`), `drizzle/0005_pgvector.sql`.
- Retrieval tools: `src/tools/rag.ts` (`runRagSearch:38`, `formatResults:85`, stage-tagged errors `:36`), `src/infra/rag-orchestrator.ts`, `src/infra/ragflow.ts`.
- Embedding/chunking (on-box): `src/lib/embed.ts` (`embedText:15`, `chunkText:47`).
- Ingest (business): `scripts/sync-turicks-brain.ts` (`syncVectorChunks:288`, Ollama probe `:332`).
- Ingest (research, auto): `src/infra/research-memory.ts`.
- Keyword/hybrid-half: `src/db/queries.ts:searchKnowledgeEntries` (`:721`), `knowledge_entries.embedding` column (unused hybrid).
- Episodic/semantic: `src/tools/memory.ts` (`search_memory:41`, `record_event:157`), `src/infra/mem0.ts`.
- Intelligence layer: `src/kernel/planner.ts` (blind router `:56-85`, `:185-252`), `src/kernel/supervisor.ts` (pure), `src/kernel/worker.ts` (isolated envelope `:1-17`, `:133-165`).
- Sandboxed worker nodes: branch `claude/founderos-antigravity-vwnrks` (`git diff origin/main origin/claude/founderos-antigravity-vwnrks` — isolated records, tool-output-guard, self-healing, worker-protocol).
- Governing ADRs: `docs/decisions/013-keep-personal-and-engineering-separate.md`, `docs/decisions/016-memory-single-source-of-truth.md`.

**Sources (external):**
- [Anthropic — Introducing Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) · [Contextual Retrieval explained (Medium)](https://medium.com/coinmonks/contextual-retrieval-anthropics-method-for-cutting-rag-failures-b28d98d57c48)
- [Advanced retrieval patterns that work in 2026 (DEV)](https://dev.to/young_gao/rag-is-not-dead-advanced-retrieval-patterns-that-actually-work-in-2026-2gbo) · [Contextual embeddings + hybrid search (freeCodeCamp)](https://www.freecodecamp.org/news/how-contextual-embeddings-and-hybrid-search-fix-retrieval-failures/)
- [Manage sessions — Claude Code Docs](https://code.claude.com/docs/en/sessions) · [Export your Claude data](https://support.claude.com/en/articles/9450526-how-can-i-export-my-claude-data) · [Where Claude Code chat logs live](https://labuladong.online/en/ai-coding/claude-code/session-storage/) · [claude-conversation-extractor](https://github.com/ZeroSumQuant/claude-conversation-extractor)
</content>
</invoke>
