# Graphify Knowledge Graph Integration

## Graph Overview
- **Nodes:** 54 (8 depts, 27 tools, 9 services)
- **Edges:** 75
- **Generated:** 2026-06-18T13:19:17.251Z

## Departments (8)
- **admin**: admin_agent
- **research**: research_agent
- **comms**: comms_agent
- **engineering**: engineering_agent
- **marketing**: marketing_agent
- **sales**: sales_agent
- **personal**: personal_agent
- **jobhunt**: jobhunt_agent

## Tools (27)
- **read_context**: Read durable business state (founder_context table) — supervisor only
- **update_context**: Update durable business state (founder_context table) — supervisor only
- **search_memory**: Unified memory search across knowledge + episodic stores — supervisor only
- **record_event**: Record a durable episodic-memory event — HITL-gated, supervisor only [HITL]
- **list_pending_signals**: list_pending_signals tool
- **search_web**: Search the web via Gemini grounding (DuckDuckGo fallback)
- **search_knowledge**: Keyword search over turicks-brain knowledge_entries (no LLM cost)
- **search_turicks_brain**: Semantic vector search over turicks_brain (business/strategy) via Ollama + pgvector
- **publish_signal**: Publish a typed cross-department signal to dept_signals (Postgres, async sweep)
- **send_email**: Send email via Composio Gmail (HITL-gated) [HITL]
- **read_emails**: Read the founder's Gmail inbox (read-only, no approval)
- **create_calendar_event**: Create a Google Calendar event via Composio (HITL-gated) [HITL]
- **github_read**: Read GitHub repos, issues, and PRs
- **github_write**: Write to GitHub (PR, commit, push) — HITL-gated [HITL]
- **project_workflow**: Run git/npm workflows in ~/Projects — HITL-gated [HITL]
- **claude_code**: Full Claude Code coding agent (files, shell, git, gh) in an isolated workspace — HITL-gated [HITL]
- **deploy_static_site**: deploy_static_site tool [HITL]
- **linkedin_post**: Post to LinkedIn via Composio — brand-validator + Claude judge then HITL-gated [HITL]
- **read_file**: Read files from the founder's laptop (path-guarded, secrets blocked)
- **list_dir**: List a single directory level on the founder's laptop (path-guarded)
- **send_file**: Attach a laptop file into Telegram — HITL-gated [HITL]
- **write_file**: Write files to the laptop — HITL-gated [HITL]
- **run_shell**: Run shell commands on the laptop — HITL-gated [HITL]
- **browser**: Safari automation on the founder's Mac — HITL-gated [HITL]
- **search_personal_rag**: Semantic vector search over personal-rag (CV/career) via Ollama + pgvector
- **read_cv**: Read the founder's CV from personal-rag (read-only)
- **search_jobs**: Search job listings via web search (Gemini grounding / DuckDuckGo)

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
  └─ belongs_to → dept_prospecting
```

### "What can the personal department do?"
```
dept_personal
  ├─ uses → tool_read_file
  ├─ uses → tool_write_file
  ├─ uses → tool_run_shell
  ├─ uses → tool_browser
  └─ uses → tool_send_file
```

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
