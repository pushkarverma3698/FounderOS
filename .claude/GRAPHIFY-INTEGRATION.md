# Graphify Knowledge Graph Integration

## Graph Overview
- **Nodes:** 55 (8 depts, 28 tools, 9 services)
- **Edges:** 76
- **Generated:** 2026-06-23T00:00:00.000Z (patched to add apply_cinematic_preset)

## Departments (8)
- **admin**: admin_agent
- **research**: research_agent
- **comms**: comms_agent
- **engineering**: engineering_agent
- **marketing**: marketing_agent
- **sales**: sales_agent
- **personal**: personal_agent
- **jobhunt**: jobhunt_agent

## Tools (28)
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
- **apply_cinematic_preset**: Copy a cinematic-web preset scaffold (neon/glass/terminal/minimal) into ~/Projects before claude_code customises it
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
1. **Read `.claude/graph.json`** before grepping files
2. **Find related nodes** (e.g., "where is search_web used?" → filter edges where `e.from === "tool_search_web"`)
3. **Navigate by structure** (e.g., "what tools does engineering have?" → filter `edges.filter(e => e.to === "dept_engineering" && e.type === "belongs_to")`)
4. **Use the query helper** (`scripts/graph-query-helper.ts`) for common patterns

## Edge Direction — IMPORTANT

Graph edges go **FROM tool TO department** with type `"belongs_to"`, NOT from department to tool.

```
tool_search_web  --[belongs_to]-->  dept_research
tool_search_web  --[belongs_to]-->  dept_sales
tool_search_web  --[belongs_to]-->  dept_marketing
```

To find all tools in a department:
```typescript
graph.edges.filter(e => e.to === "dept_research" && e.type === "belongs_to")
  .map(e => graph.nodes.find(n => n.id === e.from && n.type === "tool"))
// OR use the helper:
findToolsByDepartment("research")
```

To find all departments using a tool:
```typescript
graph.edges.filter(e => e.from === "tool_search_web" && e.type === "belongs_to")
  .map(e => graph.nodes.find(n => n.id === e.to))
// OR use the helper:
findDepartmentsByTool("search_web")
```

## Querying Examples

### "What tools does engineering have?"
```
edges.filter(e => e.to === "dept_engineering" && e.type === "belongs_to")
→ github_read, github_write, project_workflow, claude_code, apply_cinematic_preset, deploy_static_site, publish_signal
```

### "Which departments use search_web?"
```
edges.filter(e => e.from === "tool_search_web" && e.type === "belongs_to")
→ dept_research, dept_sales, dept_marketing
```

### "What is the HITL approval flow?"
```
department → supervisor → hitl → postgres (audit)
```

## PreToolUse Hook Status

The hook in `.claude/graphify-hook.ts` is **not auto-wired** — the current `.claude/settings.json`
uses a custom schema that doesn't match the Claude Code hook spec. The hook functions are tested and
work correctly in isolation (`tests/unit/graphify-hook.test.ts`), but they do not fire automatically
during Claude Code sessions.

To wire it properly, `.claude/settings.json` would need:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Glob|Grep",
        "hooks": [{"type": "command", "command": "node --import tsx/esm .claude/graphify-hook-runner.mjs \"$CLAUDE_TOOL_NAME\" \"$CLAUDE_TOOL_INPUT\""}]
      }
    ]
  }
}
```
**Until then, consult `.claude/graph.json` manually before file searches.**

## File References
- **Graph JSON:** `.claude/graph.json`
- **Mermaid Diagram:** `.claude/graph-mermaid.md`
- **Query Helper:** `scripts/graph-query-helper.ts`
- **Hook:** `.claude/graphify-hook.ts` (not auto-wired; see above)
- **Departments + Tools:** `src/agents/capabilities.ts` (single source of truth)

## Regenerating the Graph

The generator needs a live `.env` (for config.ts validation) since it imports the full capability
registry. To regenerate:
```bash
pnpm graph:gen   # requires .env to be present
```

If env is unavailable, patch `.claude/graph.json` directly and update `.claude/GRAPHIFY-INTEGRATION.md`
and `.claude/graph-mermaid.md` manually (as done in fix/graphify-issues-2026-06-23).

## Staleness Warning

The graph is a static snapshot — it drifts whenever `src/agents/capabilities.ts` changes.
There is currently **no automated staleness guard**. After adding/removing tools, always run
`pnpm graph:gen` and commit the updated graph files.
