/**
 * Generate a queryable knowledge graph from FounderOS codebase
 * Creates graph.json and integrates with Claude Code
 *
 * Derives departments + tools from the LIVE capability registry
 * (src/agents/capabilities.ts) so the graph can never drift from reality
 * (the 2026-06-15 stale-graph problem: it still listed a `prospecting`
 * department merged away months earlier, and none of the RAG/vector tools).
 */

import * as fs from "fs";
import * as path from "path";
import {
  DEPARTMENT_TOOLS,
  SUPERVISOR_TOOLS,
  HITL_GATED_TOOLS,
} from "../src/agents/capabilities.js";

interface GraphNode {
  id: string;
  type: "agent" | "tool" | "department" | "service" | "file" | "interface";
  name: string;
  description: string;
  file?: string;
  lineNumber?: number;
  exports?: string[];
  imports?: string[];
  tools?: string[];
  dependencies?: string[];
}

interface GraphEdge {
  from: string;
  to: string;
  type:
    | "imports"
    | "uses_tool"
    | "belongs_to"
    | "calls"
    | "depends_on"
    | "extends";
}

interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: {
    projectName: string;
    generatedAt: string;
    departments: Record<string, string[]>;
    tools: Record<string, string>;
  };
}

const graph: KnowledgeGraph = {
  nodes: [],
  edges: [],
  metadata: {
    projectName: "FounderOS",
    generatedAt: new Date().toISOString(),
    departments: {},
    tools: {},
  },
};

const nodeMap = new Map<string, GraphNode>();

function addNode(node: GraphNode) {
  if (!nodeMap.has(node.id)) {
    graph.nodes.push(node);
    nodeMap.set(node.id, node);
  }
}

function addEdge(edge: GraphEdge) {
  if (!graph.edges.find((e) => e.from === edge.from && e.to === edge.to)) {
    graph.edges.push(edge);
  }
}

// Human-readable descriptions for known tools (best-effort; falls back to a
// generic line for any tool not listed). The dept→tool wiring itself is derived
// from the live registry, so this map only affects prose, never structure.
const TOOL_DESCRIPTIONS: Record<string, string> = {
  search_web: "Search the web via Gemini grounding (DuckDuckGo fallback)",
  search_knowledge: "Keyword search over turicks-brain knowledge_entries (no LLM cost)",
  publish_signal: "Publish a typed cross-department signal to dept_signals (Postgres, async sweep)",
  send_email: "Send email via Composio Gmail (HITL-gated)",
  read_emails: "Read the founder's Gmail inbox (read-only, no approval)",
  create_calendar_event: "Create a Google Calendar event via Composio (HITL-gated)",
  linkedin_post: "Post to LinkedIn via Composio — brand-validator + Claude judge then HITL-gated",
  github_read: "Read GitHub repos, issues, and PRs",
  github_write: "Write to GitHub (PR, commit, push) — HITL-gated",
  project_workflow: "Run git/npm workflows in ~/Projects — HITL-gated",
  claude_code: "Full Claude Code coding agent (files, shell, git, gh) in an isolated workspace — HITL-gated",
  apply_cinematic_preset: "Copy a cinematic-web preset scaffold (neon/glass/terminal/minimal) into ~/Projects before claude_code customises it",
  read_file: "Read files from the founder's laptop (path-guarded, secrets blocked)",
  list_dir: "List a single directory level on the founder's laptop (path-guarded)",
  write_file: "Write files to the laptop — HITL-gated",
  run_shell: "Run shell commands on the laptop — HITL-gated",
  send_file: "Attach a laptop file into Telegram — HITL-gated",
  browser: "Safari automation on the founder's Mac — HITL-gated",
  search_personal_rag: "Semantic vector search over personal-rag (CV/career) via Ollama + pgvector",
  search_turicks_brain: "Semantic vector search over turicks_brain (business/strategy) via Ollama + pgvector",
  read_cv: "Read the founder's CV from personal-rag (read-only)",
  search_jobs: "Search job listings via web search (Gemini grounding / DuckDuckGo)",
  read_context: "Read durable business state (founder_context table) — supervisor only",
  update_context: "Update durable business state (founder_context table) — supervisor only",
  search_memory: "Unified memory search across knowledge + episodic stores — supervisor only",
  record_event: "Record a durable episodic-memory event — HITL-gated, supervisor only",
};

function describeTool(name: string): string {
  return TOOL_DESCRIPTIONS[name] ?? `${name} tool`;
}

// Define FounderOS architecture
function buildGraph() {
  // **DEPARTMENTS** — derived from the live registry (single source of truth).
  const departments = Object.keys(DEPARTMENT_TOOLS);

  departments.forEach((dept) => {
    addNode({
      id: `dept_${dept}`,
      type: "department",
      name: dept,
      description: `${dept} department — a ReAct agent in the supervisor graph`,
      file: "src/agents/office.ts",
    });
    graph.metadata.departments[dept] = [];
  });

  // **AGENTS** — in v2 each department IS a single ReAct agent (createReactAgent).
  departments.forEach((dept) => {
    const agentId = `${dept}_agent`;
    addNode({
      id: `agent_${agentId}`,
      type: "agent",
      name: agentId,
      description: `${dept} ReAct agent — tool-calling loop, HITL-gated writes`,
      file: "src/agents/office.ts",
    });
    addEdge({ from: `agent_${agentId}`, to: `dept_${dept}`, type: "belongs_to" });
    graph.metadata.departments[dept]!.push(agentId);
  });

  // **TOOLS** — derived from DEPARTMENT_TOOLS; a tool can belong to many depts.
  const seenTools = new Set<string>();
  for (const [dept, tools] of Object.entries(DEPARTMENT_TOOLS)) {
    for (const t of tools as Array<{ name: string }>) {
      const toolName = t.name;
      const gated = HITL_GATED_TOOLS.has(toolName);
      const description = describeTool(toolName) + (gated ? " [HITL]" : "");
      if (!seenTools.has(toolName)) {
        addNode({
          id: `tool_${toolName}`,
          type: "tool",
          name: toolName,
          description,
          file: "src/tools/*.ts",
        });
        graph.metadata.tools[toolName] = description;
        seenTools.add(toolName);
      }
      addEdge({ from: `tool_${toolName}`, to: `dept_${dept}`, type: "belongs_to" });
    }
  }

  // **SUPERVISOR TOOLS** — not delegated to departments.
  for (const t of SUPERVISOR_TOOLS as Array<{ name: string }>) {
    const toolName = t.name;
    const gated = HITL_GATED_TOOLS.has(toolName);
    const description = describeTool(toolName) + (gated ? " [HITL]" : "");
    if (!seenTools.has(toolName)) {
      addNode({ id: `tool_${toolName}`, type: "tool", name: toolName, description, file: "src/tools/*.ts" });
      graph.metadata.tools[toolName] = description;
      seenTools.add(toolName);
    }
    addEdge({ from: `tool_${toolName}`, to: "service_supervisor", type: "belongs_to" });
  }

  // **SERVICES**
  const services = [
    {
      id: "service_supervisor",
      name: "Supervisor",
      description: "Multi-agent coordinator (Gemini Flash)",
      file: "src/agents/office.ts",
    },
    {
      id: "service_telegam",
      name: "Telegram Gateway",
      description: "Telegram bot interface (grammy)",
      file: "src/gateway/telegram.ts",
    },
    {
      id: "service_hitl",
      name: "HITL (Human-in-the-loop)",
      description: "Approval system for side effects",
      file: "src/gateway/hitl.ts",
    },
    {
      id: "service_postgres",
      name: "PostgreSQL",
      description: "Durable state: leads, interrupts, audit log, checkpoints, dept_signals",
      file: "src/db/schema.ts",
    },
    {
      id: "service_redis",
      name: "Redis",
      description: "Ephemeral: cache, quotas, LLM prompt cache [SaaS-phase, not boot-critical]",
      file: "src/infra/redis.ts",
    },
    {
      id: "service_ollama",
      name: "Ollama (nomic-embed-text)",
      description: "Local 768-dim embeddings for RAG — text never leaves the box",
      file: "src/lib/embed.ts",
    },
    {
      id: "store_turicks_brain",
      name: "turicks_brain (pgvector)",
      description: "Business/strategy vector store; populated by pnpm brain:sync; queried by search_turicks_brain",
      file: "src/db/rag-search.ts",
    },
    {
      id: "store_personal_rag",
      name: "personal_rag (pgvector)",
      description: "Career/CV vector store (ADR-013/015 isolated); queried by search_personal_rag",
      file: "src/db/rag-search.ts",
    },
    {
      id: "service_judge",
      name: "Claude Judge",
      description: "Gate-2 critic for outbound copy (different model family — anti-sycophancy, fail-open)",
      file: "src/infra/judge.ts",
    },
  ];

  services.forEach((svc) => {
    addNode({
      id: svc.id,
      type: "service",
      name: svc.name,
      description: svc.description,
      file: svc.file,
    });
  });

  // **INTERFACES/TYPES**
  const interfaces = [
    {
      id: "interface_kernel_state",
      name: "KernelState",
      description: "LangGraph annotation schema for kernel graph state",
      file: "src/kernel/state.ts",
    },
    {
      id: "interface_unified_tool",
      name: "UnifiedTool",
      description: "Standard tool interface for all agents",
      file: "src/tools/*.ts",
    },
  ];

  interfaces.forEach((iface) => {
    addNode({
      id: iface.id,
      type: "interface",
      name: iface.name,
      description: iface.description,
      file: iface.file,
    });
  });

  // **KEY EDGES**
  departments.forEach((dept) => {
    // Department → Supervisor
    addEdge({
      from: `dept_${dept}`,
      to: "service_supervisor",
      type: "calls",
    });

    // Department → Telegram
    addEdge({
      from: `dept_${dept}`,
      to: "service_telegam",
      type: "calls",
    });
  });

  // Supervisor → HITL
  addEdge({
    from: "service_supervisor",
    to: "service_hitl",
    type: "calls",
  });

  // All → Postgres (durable state)
  addEdge({
    from: "service_supervisor",
    to: "service_postgres",
    type: "depends_on",
  });

  // All → Redis (cache)
  addEdge({
    from: "service_supervisor",
    to: "service_redis",
    type: "depends_on",
  });

  // RAG data flow: vector tools → Ollama (embed) + their pgvector store.
  if (nodeMap.has("tool_search_turicks_brain")) {
    addEdge({ from: "tool_search_turicks_brain", to: "service_ollama", type: "depends_on" });
    addEdge({ from: "tool_search_turicks_brain", to: "store_turicks_brain", type: "depends_on" });
  }
  if (nodeMap.has("tool_search_personal_rag")) {
    addEdge({ from: "tool_search_personal_rag", to: "service_ollama", type: "depends_on" });
    addEdge({ from: "tool_search_personal_rag", to: "store_personal_rag", type: "depends_on" });
  }
  // brain:sync embeds docs → Ollama → turicks_brain.
  addEdge({ from: "store_turicks_brain", to: "service_ollama", type: "depends_on" });
  addEdge({ from: "store_turicks_brain", to: "service_postgres", type: "depends_on" });
  addEdge({ from: "store_personal_rag", to: "service_postgres", type: "depends_on" });

  // publish_signal → Postgres dept_signals.
  if (nodeMap.has("tool_publish_signal")) {
    addEdge({ from: "tool_publish_signal", to: "service_postgres", type: "depends_on" });
  }

  // Judge gates outbound copy (marketing/sales) and uses a different model family.
  addEdge({ from: "service_supervisor", to: "service_judge", type: "depends_on" });
}

function generateGraphJson() {
  buildGraph();

  const outputPath = path.join(
    process.cwd(),
    ".claude",
    "graph.json"
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2));

  console.log(`✓ Knowledge graph generated: ${outputPath}`);
  console.log(
    `  Nodes: ${graph.nodes.length} | Edges: ${graph.edges.length}`
  );
}

function generateGraphVisualization() {
  const mermaidPath = path.join(
    process.cwd(),
    ".claude",
    "graph-mermaid.md"
  );

  let mermaid = "# FounderOS Architecture Graph\n\n```mermaid\ngraph TB\n";

  // Departments
  const deptNodes = graph.nodes.filter((n) => n.type === "department");
  deptNodes.forEach((n) => {
    mermaid += `  ${n.id}["${n.name}"]:::dept\n`;
  });

  // Tools
  const toolNodes = graph.nodes.filter((n) => n.type === "tool");
  toolNodes.forEach((n) => {
    mermaid += `  ${n.id}["${n.name}"]:::tool\n`;
  });

  // Services (type "service" + "store" both render as service-styled boxes)
  const svcNodes = graph.nodes.filter((n) => n.type === "service");
  svcNodes.forEach((n) => {
    mermaid += `  ${n.id}["${n.name}"]:::service\n`;
  });

  // All edges (the graph is small enough to render fully).
  graph.edges.forEach((e) => {
    const fromNode = graph.nodes.find((n) => n.id === e.from);
    const toNode = graph.nodes.find((n) => n.id === e.to);
    if (fromNode && toNode) {
      mermaid += `  ${e.from} -->|${e.type}| ${e.to}\n`;
    }
  });

  mermaid += `\n  classDef dept fill:#3b82f6,stroke:#1e40af,color:#fff\n`;
  mermaid += `  classDef tool fill:#10b981,stroke:#065f46,color:#fff\n`;
  mermaid += `  classDef service fill:#f59e0b,stroke:#b45309,color:#fff\n`;
  mermaid += "```\n";

  fs.writeFileSync(mermaidPath, mermaid);
  console.log(`✓ Mermaid diagram generated: ${mermaidPath}`);
}

function generateClaudeIntegration() {
  const integrationPath = path.join(process.cwd(), ".claude", "GRAPHIFY-INTEGRATION.md");

  const integration = `# Graphify Knowledge Graph Integration

## Graph Overview
- **Nodes:** ${graph.nodes.length} (${graph.nodes.filter((n) => n.type === "department").length} depts, ${graph.nodes.filter((n) => n.type === "tool").length} tools, ${graph.nodes.filter((n) => n.type === "service").length} services)
- **Edges:** ${graph.edges.length}
- **Generated:** ${graph.metadata.generatedAt}

## Departments (${Object.keys(graph.metadata.departments).length})
${Object.entries(graph.metadata.departments)
  .map(([dept, agents]) => `- **${dept}**: ${agents.join(", ")}`)
  .join("\n")}

## Tools (${Object.keys(graph.metadata.tools).length})
${Object.entries(graph.metadata.tools)
  .map(([tool, desc]) => `- **${tool}**: ${desc}`)
  .join("\n")}

## How Claude Code Uses This Graph

When Claude Code encounters a search or question:
1. **Query the graph** before grepping files
2. **Find related nodes** (e.g., "where is search_web used?" → find all edges \`tool_search_web\`)
3. **Navigate by structure** (e.g., "what tools does research have?" → find all edges \`dept_research → tool_*\`)
4. **Reduce token usage** (70x fewer tokens vs file grep)

## Querying Examples

### "How is search_web connected?"
\`\`\`
tool_search_web
  ├─ belongs_to → dept_research
  ├─ belongs_to → dept_sales
  └─ belongs_to → dept_marketing
\`\`\`

### "What can the personal department do?"
\`\`\`
dept_personal
  ├─ belongs_to (tool_read_file → dept_personal)
  ├─ belongs_to (tool_write_file → dept_personal)
  ├─ belongs_to (tool_run_shell → dept_personal)
  ├─ belongs_to (tool_browser → dept_personal)
  └─ belongs_to (tool_send_file → dept_personal)
\`\`\`

Note: graph edges go FROM tool TO department with type "belongs_to".
Use \`findToolsByDepartment(dept)\` or filter \`edges.filter(e => e.to === deptId && e.type === "belongs_to")\`.

### "What is the HITL approval flow?"
\`\`\`
department → supervisor → hitl → postgres (audit)
\`\`\`

## File References
- **Graph JSON:** \`.claude/graph.json\`
- **Mermaid Diagram:** \`.claude/graph-mermaid.md\`
- **Graph Schema:** \`src/agents/state.ts\`
- **Departments:** \`src/agents/office.ts\`
- **Tools:** \`src/tools/*.ts\`

## Regenerating the Graph
\`\`\`bash
npx tsx scripts/generate-knowledge-graph.ts
\`\`\`

## Integration with CLAUDE.md
Add to \`.claude/CLAUDE.md\`:

\`\`\`markdown
## Knowledge Graph (Graphify)

Claude Code has access to a queryable knowledge graph of the FounderOS codebase.

- **Nodes:** departments, tools, services, agents
- **Edges:** imports, uses_tool, belongs_to, calls, depends_on
- **Location:** \`.claude/graph.json\`

Before file searches, query the graph structure.
\`\`\`
`;

  fs.writeFileSync(integrationPath, integration);
  console.log(`✓ Claude integration guide generated: ${integrationPath}`);
}

// Run
generateGraphJson();
generateGraphVisualization();
generateClaudeIntegration();

console.log("\n✅ Graphify integration complete!\n");
