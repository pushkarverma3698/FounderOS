/**
 * Claude Code PreToolUse Hook for Graphify
 * Automatically enriches file operations with graph context
 *
 * This hook intercepts Read, Explore, and Find operations and provides
 * relevant graph context before the operation runs.
 */

import * as fs from "fs";
import * as path from "path";

interface GraphNode {
  id: string;
  type: string;
  name: string;
  description: string;
  file?: string;
}

interface GraphEdge {
  from: string;
  to: string;
  type: string;
}

interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: {
    departments: Record<string, string[]>;
    tools: Record<string, string>;
  };
}

let cachedGraph: Graph | null = null;

function loadGraph(): Graph {
  if (cachedGraph) return cachedGraph;

  try {
    const graphPath = path.join(
      process.cwd(),
      ".claude",
      "graph.json"
    );
    const graphData = fs.readFileSync(graphPath, "utf-8");
    const parsed = JSON.parse(graphData);
    cachedGraph = parsed;
    return parsed ?? { nodes: [], edges: [], metadata: { departments: {}, tools: {} } };
  } catch (err) {
    console.warn("⚠️ Could not load graph.json:", err instanceof Error ? err.message : err);
    return { nodes: [], edges: [], metadata: { departments: {}, tools: {} } };
  }
}

function findRelatedNodes(query: string, type?: string): GraphNode[] {
  const graph = loadGraph();
  const lowerQuery = query.toLowerCase();

  return graph.nodes.filter((node) => {
    const matches =
      node.name.toLowerCase().includes(lowerQuery) ||
      node.description.toLowerCase().includes(lowerQuery) ||
      node.id.toLowerCase().includes(lowerQuery);

    return matches && (!type || node.type === type);
  });
}

function findConnections(nodeId: string): { from: GraphEdge[]; to: GraphEdge[] } {
  const graph = loadGraph();

  return {
    from: graph.edges.filter((e) => e.from === nodeId),
    to: graph.edges.filter((e) => e.to === nodeId),
  };
}

function getFileSuggestions(filename: string): string[] {
  const graph = loadGraph();
  const fileNodes = graph.nodes.filter((n) => n.file && n.file.includes(filename));

  return Array.from(new Set(fileNodes.map((n) => n.file || "")));
}

function getDepartmentContext(deptName: string): string {
  const graph = loadGraph();
  const dept = graph.metadata.departments[deptName];

  if (!dept) return "";

  const deptNode = graph.nodes.find((n) => n.name === deptName);
  const tools = graph.nodes.filter((n) =>
    graph.edges.some((e) => e.from === n.id && e.to === `dept_${deptName}`)
  );

  return `
## Department: ${deptName}
${deptNode?.description || ""}

**Agents:** ${dept.join(", ")}
**Tools:** ${tools.map((t) => t.name).join(", ")}
`;
}

/**
 * Hook handler - called before file operations
 * Returns enriched context to display before the operation
 */
export function handlePreToolUse(toolCall: {
  tool: string;
  args: Record<string, unknown>;
}): {
  context?: string;
  suggestions?: string[];
} | null {
  const { tool, args } = toolCall;

  try {
    // READ operations - provide related file context
    if (tool === "read" || tool === "Read") {
      const filePath = args.file_path as string;
      if (!filePath) return null;

      const related = findRelatedNodes(filePath, "file");
      const suggestions = getFileSuggestions(filePath);

      if (related.length === 0 && suggestions.length === 0) return null;

      let context = "📊 **Graph Context for this file:**\n";

      if (related.length > 0) {
        context += "\n**Related nodes:**\n";
        related.forEach((node) => {
          context += `- **${node.name}** (${node.type}): ${node.description}\n`;
        });
      }

      if (suggestions.length > 0) {
        context += "\n**Other related files:**\n";
        suggestions.forEach((f) => {
          context += `- \`${f}\`\n`;
        });
      }

      return { context };
    }

    // EXPLORE operations - show department/tool structure
    if (tool === "explore" || tool === "Explore") {
      const path = args.directory as string || args.path as string;
      if (!path) return null;

      // Check if searching in src/agents or src/tools
      if (path.includes("agents")) {
        const related = findRelatedNodes("agent", "agent");
        return {
          context: `📊 **Agent Graph:**\n\n${related
            .slice(0, 5)
            .map((a) => `- **${a.name}**: ${a.description}`)
            .join("\n")}`,
          suggestions: related.map((a) => a.id),
        };
      }

      if (path.includes("tools")) {
        const graph = loadGraph();
        const tools = graph.nodes.filter((n) => n.type === "tool");
        return {
          context: `📊 **Available Tools:**\n\n${tools
            .map((t) => `- **${t.name}**: ${t.description}`)
            .join("\n")}`,
          suggestions: tools.map((t) => t.id),
        };
      }

      return null;
    }

    // GREP/FIND operations - show graph matches
    if (tool === "grep" || tool === "find") {
      const query = (args.query || args.pattern) as string;
      if (!query) return null;

      const matches = findRelatedNodes(query);
      if (matches.length === 0) return null;

      let context = `📊 **Graph matches for "${query}":**\n`;
      matches.forEach((node) => {
        context += `\n**${node.name}** (${node.type})\n`;
        context += `${node.description}\n`;
        if (node.file) context += `📄 \`${node.file}\`\n`;

        const connections = findConnections(node.id);
        if (connections.from.length > 0 || connections.to.length > 0) {
          context += `🔗 Connections:\n`;
          connections.from.forEach((e) => {
            context += `  → ${e.to} (${e.type})\n`;
          });
          connections.to.forEach((e) => {
            context += `  ← ${e.from} (${e.type})\n`;
          });
        }
      });

      return {
        context,
        suggestions: matches.map((m) => m.id),
      };
    }
  } catch (err) {
    console.error("Graphify hook error:", err);
    return null;
  }

  return null;
}

/**
 * Export for testing
 */
export { loadGraph, findRelatedNodes, findConnections, getDepartmentContext };
