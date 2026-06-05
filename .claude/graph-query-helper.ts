/**
 * Helper functions to query the FounderOS knowledge graph
 * Usage: Use these patterns in Claude Code when searching
 */

import graph from "./graph.json";

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

  return graph.edges
    .filter((e: Edge) => e.from === deptNode.id && e.type === "uses_tool")
    .map((e: Edge) => {
      const tool = graph.nodes.find((n: Node) => n.id === e.to);
      return tool?.name || "";
    })
    .filter(Boolean);
}

export function findDepartmentsByTool(toolName: string): string[] {
  const toolNode = graph.nodes.find(
    (n: Node) => n.type === "tool" && n.name === toolName
  );
  if (!toolNode) return [];

  return graph.edges
    .filter((e: Edge) => e.to === toolNode.id && e.type === "uses_tool")
    .map((e: Edge) => {
      const dept = graph.nodes.find((n: Node) => n.id === e.from);
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
