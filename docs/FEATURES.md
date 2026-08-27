# FounderOS — Features (what it does, end to end)

Every capability below is real and wired through the [capability
registry](../src/agents/capabilities.ts) — the single source of truth. Tools
marked 🔒 pause for founder approval (HITL) before they act. Read-only tools run
without a gate.

For *how* a request flows through the system, see [ARCHITECTURE.md](ARCHITECTURE.md).
For the visual map, see [diagram 10](diagrams/10-capability-map.md).

---

## The 8 workers

FounderOS routes each planned step to one of eight isolated workers. Each carries
a deliberately small, purpose-fit tool set (least privilege).

### 🗂️ admin
Persistent context and orchestration bookkeeping.
- `read_context` / `update_context` — durable founder context across turns
- `search_memory` — "what did we decide about X?"
- `record_event` 🔒 · `schedule_task` 🔒 / `list_scheduled` / `edit_scheduled`
- `list_workflows` — the reusable-script catalog (`run_count` = most used)

### 🔎 research
Read-only intelligence.
- `search_web`, `scrape_url`, `crawl_site`, `deep_research`, `search_research_cache`
- `search_knowledge` / `search_turicks_brain` — internal knowledge (RAG)
- `scan_ai_visibility`, `get_gap_scans` — how the brand shows up in AI answers
- `publish_signal` — hand a typed signal to another worker

### ✉️ comms
Inbox and calendar.
- `send_email` 🔒 · `read_emails`
- `create_calendar_event` 🔒
- `schedule_social_post` 🔒 / `list_scheduled_posts`

### 🛠️ engineering
Code and deployment.
- `github_read` · `github_write` 🔒
- `project_workflow` 🔒 — run a saved build/deploy workflow
- `claude_code` 🔒 — delegate a coding task to a Claude Code executor
- `deploy_static_site` 🔒 · `vps_run` 🔒 (config-gated) · `publish_signal`

### 📣 marketing
LinkedIn growth + creative.
- `linkedin_post` 🔒, `linkedin_get_my_posts`, `linkedin_analytics`, `linkedin_read_comments`
- `draft_linkedin_reply` 🔒, `draft_connection_note` 🔒
- `generate_image`, `list_brand_assets`
- video: `list_video_brands`, `compile_video_brief`, `compile_shotlist`, `plan_video_production`, `video_production_status`
- `search_knowledge` / `search_turicks_brain`

### 💼 sales
Outreach grounded in real research.
- `send_email` 🔒 · `search_web`
- `search_knowledge` / `search_turicks_brain` — ICP + messaging

### 💻 personal
The founder's laptop operator — walled off from business workers.
- `read_file`, `list_dir`, `write_file` 🔒, `send_file` 🔒
- `run_shell` 🔒, `browser` 🔒
- `search_personal_rag` — founder-private career/CV data

### 🎯 jobhunt
Career pipeline.
- `read_cv`, `search_jobs`, `send_email` 🔒
- `search_personal_rag` — CV-to-JD semantic matching

**This is the single largest production consumer of the kernel** — the tool set above is
deliberately small (least privilege), but the pipeline behind it is 81 files / ~14.8k LOC:
board discovery across 900+ ATS boards, lawful-sponsorship and salary screening, CV tailoring,
and a founder-click-to-submit apply flow. It runs daily against real postings, not fixtures.
Full pipeline: [docs/JOBHUNT.md](JOBHUNT.md).

---

## Cross-cutting features (how they work)

### Human-in-the-loop approval (17 gated tools)
Every write/send/spend tool pauses at a LangGraph `interrupt()`. The gateway
renders a Telegram card with the exact action (recipient, subject, body, diff,
command) and Approve/Reject buttons. Because graph state is checkpointed in
Postgres, a pending approval **survives a process restart**. The side effect runs
only after an approved resume. → [diagram 03](diagrams/03-hitl-flow.md),
[HITL matrix](guides/HITL-MATRIX.md).

### Action claims grounded in receipts, not model output
An action step must return a code-recorded `ToolReceipt` with `ok: true`, or the
result is rejected as unproven. The synthesizer is fed only validated results, never
raw tool output, so it cannot claim an action that didn't happen. → [diagram 07](diagrams/07-receipt-and-zero-hallucination.md).

### Idempotent sends
Before any external send, a deterministic, tenant-scoped, content-addressed
idempotency key (`sha1` of the action parts) is checked against `action_log`. A
retry finds the prior audit row and skips the duplicate. You can safely
re-approve; you can't double-send.

### Cross-turn memory
Each completed turn is folded into the checkpointed `history` channel and replayed
to the planner. So "send it" or "do the same for Acme" resolves against real prior
turns — while workers still see only their envelope. Deeper recall via
`search_memory` over `episodic_memory`, and business/career knowledge via the
`brain` schema RAG stores.

### Scheduling & automation
`schedule_task` 🔒 registers a future kernel turn (a minute-resolution sweep fires
it on the founder thread); `schedule_social_post` 🔒 queues LinkedIn posts. Saved
workflows (`saved_workflows`, ranked by `run_count`) are reusable scripts the
engineering worker can re-run via `project_workflow`.

### Budget guard
Per-run and per-day USD caps (`RUN_BUDGET_USD`, `BUDGET_DAILY_USD`) are enforced
before work proceeds; every model call's cost is written to `ai_call_costs`.
`pnpm proof:costs` regenerates the cost ledger.

### Research & AI-visibility
`deep_research` and the Firecrawl-backed web tools feed a 24h research cache.
`scan_ai_visibility` / `get_gap_scans` measure how Turicks surfaces in AI answers
— input to the marketing loop.

### Video Factory
A standalone client social-video engine (`video-factory/`, outside the pnpm
workspace). The kernel side is pure, $0 tools (`compile_video_brief`,
`compile_shotlist`, `plan_video_production`, …). → [VIDEO-FACTORY.md](VIDEO-FACTORY.md).

### Read-only MCP surface
`src/mcp/` exposes read tools (search knowledge, read context, github read) to
external MCP clients — no write path. → [MCP-SERVERS.md](guides/MCP-SERVERS.md).

---

## Founder controls (Telegram commands)

A small set of essential commands (`src/gateway/commands.ts`) — including halt /
resume and `/reset` (the only thing that wipes a thread). Day-to-day operations:
[OPERATIONS.md](guides/OPERATIONS.md).

---

## What it deliberately does NOT do

- No autonomous sends — every external action is gated.
- No unbounded plans — `MAX_PLAN_STEPS = 8`, `MAX_TOOL_CALLS_PER_STEP = 6`.
- No cross-store writes between `turicks-brain` and `personal-rag` (ADR-013/015).
- No paid model calls in the dev loop — `pnpm test` is $0.

Honest gaps and deferred work: [LIMITATIONS.md](LIMITATIONS.md).
