/**
 * Helper functions to query the FounderOS knowledge graph
 * Usage: Use these patterns in Claude Code when searching
 */

// The generated knowledge graph lives in .claude/graph.json (repo-root tooling
// dir). This helper was moved from .claude/ → scripts/ in 104bb7e, which broke
// the old "./graph.json" relative import and pulled the file into tsconfig's
// "scripts/**/*" compile scope — a red `tsc --noEmit` (= `pnpm lint`) that
// blocked all of CI and therefore every production deploy. Point at the real path.
import graph from "../.claude/graph.json" with { type: "json" };

// Types
interface Node {
  id: string;
  type: string;
  name: string;
  description: string;
  file?: string;
}

interface Edge {
  from: string;
  to: string;
  type: string;
}

// Query functions
export function findNodesByType(type: string): Node[] {
  return graph.nodes.filter((n: Node) => n.type === type);
}

export function findNodeByName(name: string): Node | undefined {
  return graph.nodes.find(
    (n: Node) => n.name.toLowerCase() === name.toLowerCase()
  );
}

export function findEdgesFrom(nodeId: string): Edge[] {
  return graph.edges.filter((e: Edge) => e.from === nodeId);
}

export function findEdgesTo(nodeId: string): Edge[] {
  return graph.edges.filter((e: Edge) => e.to === nodeId);
}

export function findToolsByDepartment(dept: string): string[] {
  const deptNode = graph.nodes.find(
    (n: Node) => n.type === "department" && n.name === dept
  );
  if (!deptNode) return [];

  // Edges go FROM tool TO department with type "belongs_to" (not "uses_tool" from dept to tool)
  return graph.edges
    .filter((e: Edge) => e.to === deptNode.id && e.type === "belongs_to")
    .map((e: Edge) => {
      const tool = graph.nodes.find((n: Node) => n.id === e.from && n.type === "tool");
      return tool?.name || "";
    })
    .filter(Boolean);
}

export function findDepartmentsByTool(toolName: string): string[] {
  const toolNode = graph.nodes.find(
    (n: Node) => n.type === "tool" && n.name === toolName
  );
  if (!toolNode) return [];

  // Edges go FROM tool TO department with type "belongs_to"
  return graph.edges
    .filter((e: Edge) => e.from === toolNode.id && e.type === "belongs_to")
    .map((e: Edge) => {
      const dept = graph.nodes.find((n: Node) => n.id === e.to && n.type === "department");
      return dept?.name || "";
    })
    .filter(Boolean);
}

export function findAgentsByDepartment(dept: string): string[] {
  const deptNode = graph.nodes.find(
    (n: Node) => n.type === "department" && n.name === dept
  );
  if (!deptNode) return [];

  return graph.edges
    .filter((e: Edge) => e.from.startsWith("agent_") && e.to === deptNode.id)
    .map((e: Edge) => {
      const agent = graph.nodes.find((n: Node) => n.id === e.from);
      return agent?.name || "";
    })
    .filter(Boolean);
}

export function getGraphSummary(): string {
  return `
FounderOS Knowledge Graph Summary:
- Departments: ${findNodesByType("department").length}
- Agents: ${findNodesByType("agent").length}
- Tools: ${findNodesByType("tool").length}
- Services: ${findNodesByType("service").length}
- Total Edges: ${graph.edges.length}

Departments:
${Object.entries(graph.metadata.departments)
  .map(([dept, agents]) => `  - ${dept}: ${(agents as string[]).join(", ")}`)
  .join("\n")}

Key Services:
  - Supervisor: Multi-agent orchestrator
  - Telegram: Messaging gateway
  - HITL: Approval system
  - PostgreSQL: Durable state
  - Redis: Ephemeral cache
`;
}

// Export the raw graph for advanced queries
export { graph };
