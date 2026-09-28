# Graphify Knowledge Graph Integration

## Graph Overview
- **Nodes:** 98 (8 depts, 71 tools, 9 services)
- **Edges:** 117
- **Generated:** 2026-09-28T14:11:03.332Z

## Departments (8)
- **admin**: admin_agent
- **research**: research_agent
- **comms**: comms_agent
- **engineering**: engineering_agent
- **marketing**: marketing_agent
- **sales**: sales_agent
- **personal**: personal_agent
- **jobhunt**: jobhunt_agent

## Tools (71)
- **read_context**: Read durable business state (founder_context table) — supervisor only
- **update_context**: Update durable business state (founder_context table) — supervisor only
- **search_memory**: Unified memory search across knowledge + episodic stores — supervisor only
- **record_event**: Record a durable episodic-memory event — HITL-gated, supervisor only [HITL]
- **list_pending_signals**: list_pending_signals tool
- **schedule_task**: schedule_task tool [HITL]
- **list_scheduled**: list_scheduled tool
- **edit_scheduled**: edit_scheduled tool
- **set_reminder**: set_reminder tool
- **list_reminders**: list_reminders tool
- **edit_reminder**: edit_reminder tool
- **list_workflows**: list_workflows tool
- **synthesize_skill**: synthesize_skill tool [HITL]
- **ops_state**: ops_state tool
- **write_artifact**: write_artifact tool
- **deliver_artifact**: deliver_artifact tool [HITL]
- **read_logs**: read_logs tool
- **search_web**: Search the web via Gemini grounding (DuckDuckGo fallback)
- **scrape_url**: scrape_url tool
- **deep_research**: deep_research tool
- **crawl_site**: crawl_site tool
- **youtube_transcript**: youtube_transcript tool
- **v2ex_topics**: v2ex_topics tool
- **search_research_cache**: Semantic search over pages the research worker already scraped (research_cache)
- **search_knowledge**: Hybrid (vector + keyword) search over the turicks-brain store, brain_memories (no LLM cost)
- **publish_signal**: Publish a typed cross-department signal to dept_signals (Postgres, async sweep)
- **scan_ai_visibility**: scan_ai_visibility tool
- **get_gap_scans**: get_gap_scans tool
- **send_email**: Send email via Composio Gmail (HITL-gated) [HITL]
- **read_emails**: Read the founder's Gmail inbox (read-only, no approval)
- **create_calendar_event**: Create a Google Calendar event via Composio (HITL-gated) [HITL]
- **schedule_social_post**: schedule_social_post tool [HITL]
- **list_scheduled_posts**: list_scheduled_posts tool
- **project_workflow**: Run git/npm workflows in ~/Projects — HITL-gated [HITL]
- **claude_code**: Full Claude Code coding agent (files, shell, git, gh) in an isolated workspace — HITL-gated [HITL]
- **dispatch_antigravity_task**: dispatch_antigravity_task tool [HITL]
- **create_project_repo**: create_project_repo tool [HITL]
- **apply_cinematic_preset**: Copy a cinematic-web preset scaffold (neon/glass/terminal/minimal) into ~/Projects before claude_code customises it
- **deploy_static_site**: deploy_static_site tool [HITL]
- **vps_run**: vps_run tool [HITL]
- **github_read**: Read GitHub repos, issues, and PRs
- **ui_check**: ui_check tool [HITL]
- **linkedin_post**: Post to LinkedIn via Composio — brand-validator + Claude judge then HITL-gated [HITL]
- **linkedin_get_my_posts**: linkedin_get_my_posts tool
- **linkedin_analytics**: linkedin_analytics tool
- **linkedin_read_comments**: linkedin_read_comments tool
- **draft_linkedin_reply**: draft_linkedin_reply tool [HITL]
- **draft_connection_note**: draft_connection_note tool [HITL]
- **generate_image**: generate_image tool
- **list_brand_assets**: list_brand_assets tool
- **list_video_brands**: list_video_brands tool
- **compile_video_brief**: compile_video_brief tool
- **compile_shot_list**: compile_shot_list tool
- **plan_video_production**: plan_video_production tool
- **video_production_status**: video_production_status tool
- **read_file**: Read files from the founder's laptop (path-guarded, secrets blocked)
- **list_dir**: List a single directory level on the founder's laptop (path-guarded)
- **run_shell**: Run shell commands on the laptop — HITL-gated [HITL]
- **browser**: Safari automation on the founder's Mac — HITL-gated [HITL]
- **send_file**: Attach a laptop file into Telegram — HITL-gated [HITL]
- **write_file**: Write files to the laptop — HITL-gated [HITL]
- **read_cv**: Read a candidate's CV — the one CV reader, either candidate (read-only)
- **search_jobs**: Search job listings via web search (Gemini grounding / DuckDuckGo)
- **ingest_jobs**: ingest_jobs tool
- **screen_job**: screen_job tool
- **review_screened**: review_screened tool
- **cv_gaps**: cv_gaps tool
- **job_state**: job_state tool
- **export_jobs_csv**: export_jobs_csv tool
- **tailor_cv**: tailor_cv tool
- **job_brief**: job_brief tool

## How Claude Code Uses This Graph

When Claude Code encounters a search or question:
1. **Query the graph** before grepping files
2. **Find related nodes** (e.g., "where is search_web used?" → find all edges `tool_search_web`)
3. **Navigate by structure** (e.g., "what tools does research have?" → find all edges `dept_research → tool_*`)
4. **Reduce token usage** (70x fewer tokens vs file grep)

## Querying Examples

### "How is search_web connected?"
```
tool_search_web
  ├─ belongs_to → dept_research
  ├─ belongs_to → dept_sales
  └─ belongs_to → dept_marketing
```

### "What can the personal department do?"
```
dept_personal
  ├─ belongs_to (tool_read_file → dept_personal)
  ├─ belongs_to (tool_write_file → dept_personal)
  ├─ belongs_to (tool_run_shell → dept_personal)
  ├─ belongs_to (tool_browser → dept_personal)
  └─ belongs_to (tool_send_file → dept_personal)
```

Note: graph edges go FROM tool TO department with type "belongs_to".
Use `findToolsByDepartment(dept)` or filter `edges.filter(e => e.to === deptId && e.type === "belongs_to")`.

### "What is the HITL approval flow?"
```
department → supervisor → hitl → postgres (audit)
```

## File References
- **Graph JSON:** `.claude/graph.json`
- **Mermaid Diagram:** `.claude/graph-mermaid.md`
- **Graph Schema:** `src/agents/state.ts`
- **Departments:** `src/agents/office.ts`
- **Tools:** `src/tools/*.ts`

## Regenerating the Graph
```bash
npx tsx scripts/generate-knowledge-graph.ts
```

## Integration with CLAUDE.md
Add to `.claude/CLAUDE.md`:

```markdown
## Knowledge Graph (Graphify)

Claude Code has access to a queryable knowledge graph of the FounderOS codebase.

- **Nodes:** departments, tools, services, agents
- **Edges:** imports, uses_tool, belongs_to, calls, depends_on
- **Location:** `.claude/graph.json`

Before file searches, query the graph structure.
```
