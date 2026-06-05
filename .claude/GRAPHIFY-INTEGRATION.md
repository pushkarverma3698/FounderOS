# Graphify Knowledge Graph Integration

## Graph Overview
- **Nodes:** 43 (8 depts, 13 tools, 5 services)
- **Edges:** 47
- **Generated:** 2026-06-05T10:43:57.287Z

## Departments (8)
- **research**: lead_intel, researcher
- **comms**: email_agent, linkedin_agent
- **engineering**: eng_engineer, code_reviewer, github_agent
- **marketing**: marketing_engineer, content_gen
- **sales**: sales_engineer, bdr, outreach
- **prospecting**: icp_scorer
- **personal**: personal_operator
- **jobhunt**: job_hunter

## Tools (13)
- **search_web**: Search the web via Firecrawl
- **send_email**: Send emails via Composio Gmail (HITL-gated)
- **linkedin_post**: Post to LinkedIn via Composio (HITL-gated approval)
- **github_read**: Read GitHub repos and issues
- **github_write**: Write to GitHub (PR, commit, push) — HITL-gated approval required
- **read_file**: Read files from laptop
- **write_file**: Write files to laptop (HITL-gated approval)
- **run_shell**: Run shell commands (HITL-gated approval)
- **send_file**: Send files via Telegram (HITL-gated approval)
- **browser**: Control browser via AppleScript (HITL-gated approval)
- **read_cv**: Read personal CV from personal-rag
- **search_jobs**: Search job listings via Firecrawl
- **project_workflow**: Run git/npm commands in ~/Projects (HITL-gated for dangerous commands)

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
