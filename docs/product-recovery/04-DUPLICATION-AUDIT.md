# Duplication Audit

The thesis predicted widespread capability duplication. **Measured, most of it is not there.**
The real problem is the opposite shape: *one worker carrying too many near-synonymous tools*, and
*orphaned subsystems nobody routes to*.

Format per the mission brief: CAPABILITY · IMPLEMENTATIONS · CURRENT ROUTING · CANONICAL · WHY ·
RETAIN · REMOVE · MIGRATION.

---

## D1. Browser — **NOT duplicated**

- **Implementations:** 1 model-facing tool (`browser`), 2 backends behind it.
- **Current routing:** personal worker → `browserAction()` → `BROWSER_BACKEND` switch → Safari
  (macOS) or Playwright (Linux).
- **Canonical:** `browserAction()`. Already correct.
- **Remove:** nothing.
- **Migration:** none. **Add a post-action observation return, that is all.**

> The thesis listed 6 competing browser paths. `browser-playwright.ts` has exactly one importer.
> Consolidation here would delete a working abstraction.

## D2. Memory / retrieval — **GENUINELY duplicated at the decision point**

| Implementation | Backend | Exposed to |
|---|---|---|
| `search_personal_rag` | pgvector `personal_rag` | personal, jobhunt |
| `search_turicks_brain` | pgvector `turicks_brain` | personal, research, sales, marketing |
| `search_research_cache` | pgvector web findings | research |
| `search_knowledge` | relational `knowledge_entries` | research, marketing, sales |
| `search_memory` | Postgres + mem0 | admin |

- **Current routing:** the LLM picks. `personal` sees 2 of them, `research` sees 3.
- **Canonical:** **one** `recall(query, scope?)` tool; scope inferred from worker, backend chosen
  by code.
- **Why:** these are five *storage locations*, not five *capabilities*. The founder never asks
  "search my personal RAG" — he asks a question.
- **Retain underneath:** all five backends. This is an interface change, not a data migration.
- **Remove from the model's view:** four tool names.
- **Migration:** Phase 7. Mechanical. Keep old names as deprecated aliases for one release.

## D3. Code execution — **duplicated, needs ownership not deletion**

| Implementation | Worker | Genuine distinct use |
|---|---|---|
| `claude_code` | engineering | full agentic coding in isolated workspace |
| `project_workflow` | engineering | saved-script catalog |
| `vps_run` | engineering | remote shell on prod |
| `run_shell` | personal | local shell on founder's Mac |
| `github_write` | engineering | direct repo write |

- **Verdict:** all five have distinct blast radii. **Do not merge.**
- **Problem:** the *prompt* does not tell the planner when each applies, so choice is ambiguous.
- **Action:** Phase 7 — sharpen descriptions, not the registry. Zero tools removed.

## D4. Research — **too many tools, not duplicates**

12 tools on one worker. `search_web`, `scrape_url`, `deep_research`, `crawl_site` genuinely
differ in cost and depth — but the model has no cost signal to choose between them.

- **Action:** Phase 7 — collapse the *presentation* to `research(query, depth: quick|deep|crawl)`
  with the existing four behind it. Retain all four executors.

## D5. Marketing — **18 tools, the worst decision surface in the system**

`linkedin_post, linkedin_get_my_posts, linkedin_analytics, linkedin_read_comments,
draft_linkedin_reply, draft_connection_note, list_scheduled_posts, search_web, search_knowledge,
search_turicks_brain, publish_signal, generate_image, list_brand_assets, list_video_brands,
compile_video_brief, compile_shot_list, plan_video_production, video_production_status`

Plus a 13,138-char prompt. `MARKETING_SUBAGENT_TOOLS` already defines the right clusters
(`social` / `video` / `creative`) and **is not used by the v3 kernel**.

- **Action:** Phase 7 — either wire the existing clusters or split the worker. Prefer the split;
  it needs no new abstraction.

## D6. Orphaned subsystems — **delete**

| Subsystem | LOC | Importers |
|---|---:|---|
| `src/outreach/` | 648 | 0 |
| `src/workflows/` | 372 | 0 |
| `src/bench/` | 198 | 0 |
| `src/kernel/context-composer.ts` | 88 | tests only |
| `SUPERVISOR_PROMPT` + `buildSupervisorPrompt` | 13.5k chars | self + barrel |

~1,306 LOC + 13.5k chars of prompt. **Phase 6.** All git-recoverable.

> `src/proof/` was checked and is **live** — `scripts/proof-{scoreboard,cost-ledger}.ts` and
> `export-case-study.ts` import `src/proof/render.js`. Do not delete.

## D7. Duplication that does NOT exist

Checked and cleared — do not spend a phase on these:

- Hermes vs. tools (Hermes is a lesson store; see `07-…`)
- Skills vs. tools (5 Apify skills, no runtime selection layer)
- Multiple routers (v3 has exactly one: `makePlanNode`; regex routing ratchet = 0)
- Multiple supervisors (the LLM supervisor is a CI-enforced tombstone)
- Competing checkpointers (one, PostgresSaver)

---

## Net

| Action | Count |
|---|---|
| Tools deleted | **0** |
| Tool *names the model sees* removed | ~10 (D2, D4) |
| LOC deleted | ~1,306 |
| Workers re-shaped | 1 (marketing) |

**Reduce choices, not power** — as specified.
