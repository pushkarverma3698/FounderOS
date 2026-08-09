# Capability Map

For each capability: the canonical path, and **the exact link where the chain stops**.

Chain notation: `INTENT → PLAN → WORKER → TOOL → EXTERNAL → OBSERVE → VERIFY → DELIVER`

---

## Legend

- ✅ link works
- ⚠️ link works but is the wrong shape for the objective
- ❌ link absent
- 🚫 capability does not exist

---

## 1. Job state query — *"what jobs have been captured"*

| Link | State | Detail |
|---|---|---|
| INTENT | ✅ | planner understood |
| PLAN | ✅ | 2 steps: jobhunt "list all captured" → admin "format as CSV" |
| WORKER | ✅ | jobhunt |
| TOOL | 🚫 | **no tool reads `job_applications` generically.** jobhunt carries `read_cv, search_jobs, ingest_jobs, screen_job, review_screened, cv_gaps, job_brief, send_email, search_personal_rag` |
| substitute | ⚠️ | worker picked `job_brief` → returns a **ranked prose brief**, not a record set |
| OBSERVE | ❌ | nothing counted rows |
| VERIFY | ❌ | no verifier for `jobhunt` |
| DELIVER | ❌ | CSV emitted as inline chat text |

**Canonical implementation: does not exist.** Closest is `review_screened` (max 100 rows, text).

## 2. Artifact creation & delivery — *"give me a CSV / file"*

| Link | State | Detail |
|---|---|---|
| CREATE | ⚠️ | `write_artifact` — **admin only**, hardcoded `.md` extension (`src/tools/artifact.ts`), writes to `./artifacts` (CWD-relative) |
| PATH | ❌ | `/opt/founderos/artifacts` **does not exist on prod** |
| DELIVER | ❌ | `send_file` is **personal-dept only** and path-guarded to `personalRoot()` = `$HOME` = `/home/founderos`. `./artifacts` resolves to `/opt/founderos/artifacts` — **outside the guard** |

**There is no path from "produce a file" to "founder receives a file."** Two tools exist; they
live on different workers and their filesystem roots do not intersect. This is a wiring gap, not
a missing feature.

## 3. Job discovery (free lane)

| Link | State | Detail |
|---|---|---|
| SCHEDULE | ✅ | `*/30 * * * *`, fires reliably |
| FETCH | ✅ | 285 boards, ~20,550 candidates |
| FILTER | ❌ | **drops 100%** — `filterCandidates` / `keepUnseen` / `hydrateDescriptions` |
| SCREEN | — | receives 0 |
| NOTIFY | ✅ | heartbeat + `isNew` dedup logic is **correct in current HEAD** |
| OBSERVE | ⚠️ | funnel counts computed into `notes[]` then **discarded on quiet sweeps** |

The notification layer everyone suspected is fine. The funnel above it is closed and the
instrumentation that would have shown it is thrown away.

## 4. Job application

| Link | State |
|---|---|
| QUEUE | ✅ 6 rows in `do_today` |
| EXECUTE | ⚠️ Mac client, invoked by **pasting a shell command to the founder** |
| RECORD | ❌ `updateApplicationStage` has no kernel caller (carried open from 2026-08-02) |
| OUTCOME | 2 applications, ever |

## 5. Browser

| Link | State |
|---|---|
| TOOL | ✅ **one** tool `browser`, personal dept, HITL-gated |
| EXECUTOR | ✅ `browserAction()` switches Safari/AppleScript ↔ Playwright on `BROWSER_BACKEND` |
| OBSERVE | ⚠️ returns stdout; no structured page state |
| VERIFY | ❌ no post-action check that the click did anything |

**Already canonical.** Do not consolidate. Only the verify link is missing.

## 6. Code change

| Link | State |
|---|---|
| TOOL | ✅ `claude_code` (engineering), HITL-gated, isolated workspace |
| ALTERNATES | ⚠️ `project_workflow`, `vps_run`, `run_shell` (personal), `github_write` all overlap |
| VERIFY | ❌ none — no "did tests pass" gate |

## 7. Research

| Link | State |
|---|---|
| TOOLS | ⚠️ **12 on one worker**: `search_web, scrape_url, deep_research, crawl_site, youtube_transcript, v2ex_topics, search_research_cache, search_knowledge, search_turicks_brain, publish_signal, scan_ai_visibility, get_gap_scans` |
| VERIFY | ❌ none |

Highest tool-selection entropy in the system after marketing (18).

## 8. Memory / knowledge retrieval

Four separately-named tools, three distinct backends:

| Tool | Backend | Worker(s) |
|---|---|---|
| `search_personal_rag` | pgvector `personal_rag` | personal, jobhunt |
| `search_turicks_brain` | pgvector `turicks_brain` | personal, research, sales, marketing |
| `search_research_cache` | pgvector (web findings) | research |
| `search_knowledge` | relational `knowledge_entries` | research, marketing, sales |
| `search_memory` | Postgres + mem0 | admin |

**Five retrieval tools, no router.** The model chooses which memory to consult. See
`06-CONTEXT-RAG-MEMORY.md`.

---

## Summary — where objectives die

| Failure link | Capabilities affected |
|---|---|
| **No canonical read of own structured state** | jobs, applications, schedules, costs |
| **No artifact create→deliver path** | every "give me a file" request |
| **No verification** | 7 of 8 workers |
| **No outcome recording** | all — `writeTaskOutcome` has 0 callers |
| **Funnel instrumentation discarded** | job lane |
