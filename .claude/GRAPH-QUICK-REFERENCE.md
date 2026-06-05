# FounderOS Knowledge Graph — Quick Reference

## 🎯 Use This First
Before searching files or exploring code, **query the graph** for structure.

## Departments & Tools

### research
- **Tools:** search_web
- **Agents:** lead_intel, researcher
- **Purpose:** Web research, lead intelligence gathering

### comms
- **Tools:** send_email, linkedin_post
- **Agents:** email_agent, linkedin_agent
- **Purpose:** Email and LinkedIn communications (HITL-gated sends)

### engineering
- **Tools:** github_read, github_write, project_workflow
- **Agents:** eng_engineer, code_reviewer, github_agent
- **Purpose:** GitHub automation, code review, project management
- **HITL Gates:** github_write, project_workflow (dangerous commands)

### marketing
- **Tools:** search_web, linkedin_post
- **Agents:** marketing_engineer, content_gen
- **Purpose:** LinkedIn content, brand voice
- **HITL Gates:** linkedin_post

### sales
- **Tools:** search_web, send_email
- **Agents:** sales_engineer, bdr, outreach
- **Purpose:** Cold outreach, email prospecting
- **HITL Gates:** send_email (outreach)

### prospecting
- **Tools:** search_web
- **Agents:** icp_scorer
- **Purpose:** ICP scoring, lead qualification

### personal
- **Tools:** read_file, write_file, run_shell, browser, send_file
- **Agents:** personal_operator
- **Purpose:** Laptop automation, file/shell/browser control
- **HITL Gates:** write_file, run_shell, browser, send_file
- **Safety:** Path guard confines to `$HOME`; secrets blocked

### jobhunt
- **Tools:** read_cv, search_jobs, send_email
- **Agents:** job_hunter
- **Purpose:** Job search, application management
- **Read-Only:** read_cv (personal-rag), search_jobs
- **HITL Gates:** send_email

## Core Services

| Service | Purpose | Location |
|---------|---------|----------|
| **Supervisor** | Multi-agent orchestrator (Gemini Flash) | `src/agents/office.ts` |
| **Telegram** | Bot gateway (grammy, long-poll) | `src/gateway/telegram.ts` |
| **HITL** | Human approval system | `src/gateway/hitl.ts` |
| **PostgreSQL** | Durable state (leads, interrupts, audit) | `src/db/schema.ts` |
| **Redis** | Ephemeral cache (quotas, LLM cache) | `src/infra/redis.ts` |

## File Locations by Role

| Task | File |
|------|------|
| **Add a new tool** | `src/tools/{name}.ts` + register in `src/tools/index.ts` |
| **Add a new agent** | `src/agents/office.ts` + system prompt in `src/agents/system-prompts.ts` |
| **Modify HITL logic** | `src/agents/agent-tools.ts` (hitlGate helper) + `src/gateway/hitl.ts` |
| **Change brand voice** | `src/infra/brand-validator.ts` + `src/agents/system-prompts.ts` |
| **Add routing logic** | `src/agents/office.ts` + golden tasks in `src/eval/golden-tasks.ts` |
| **Fix Telegram rendering** | `src/gateway/format.ts` |
| **Update graph** | `scripts/generate-knowledge-graph.ts` |

## Query Examples

### "Which tools does research have?"
→ Navigate graph edges: `dept_research` → (all edges with type `uses_tool`)
→ Answer: `search_web`

### "What departments can send emails?"
→ Find all edges: `* → tool_send_email`
→ Departments: `comms`, `sales`, `jobhunt`

### "How does HITL approval work?"
→ Query: `dept_* → supervisor → hitl → postgres`
→ Flow: agent calls tool → interrupt() → Telegram approval card → resume() → execute

### "Where is github_write protected?"
→ Find: `tool_github_write` has HITL gate
→ Location: `src/agents/agent-tools.ts` (hitlGate wrapper) + `src/gateway/hitl.ts`

### "What can personal department access?"
→ Tools: `read_file` (ungated) · `write_file, run_shell, browser, send_file` (all HITL)
→ Safety: `src/infra/path-guard.ts` — confines to `$HOME`, blocks secrets even on read

## Graph Statistics
- **Nodes:** 43 (8 departments, 18 agents, 12 tools, 5 services)
- **Edges:** 47 (dependency graph)
- **Generated:** 2026-06-05T10:42:36Z

## Visualization
- **Mermaid diagram:** `.claude/graph-mermaid.md` (open in GitHub/editor)
- **Raw JSON:** `.claude/graph.json` (machine-readable)

---

**Use this graph, not file search, for architectural questions.** It cuts token usage by ~70%.
