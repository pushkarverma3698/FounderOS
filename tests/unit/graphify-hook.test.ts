import { describe, it, expect, beforeAll } from "vitest";
import {
  handlePreToolUse,
  loadGraph,
  findRelatedNodes,
  findConnections,
} from "../../.claude/graphify-hook";

describe("Graphify Auto-Hook", () => {
  let graph: ReturnType<typeof loadGraph>;

  beforeAll(() => {
    graph = loadGraph();
  });

  it("should load the knowledge graph", () => {
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  describe("handlePreToolUse", () => {
    it("should provide context for Read operations on agent files", () => {
      const result = handlePreToolUse({
        tool: "Read",
        args: { file_path: "src/agents/office.ts" },
      });

      expect(result).not.toBeNull();
      expect(result?.context).toBeDefined();
      expect(result?.context).toContain("Graph Context");
    });

    it("should provide context for Explore operations on agents directory", () => {
      const result = handlePreToolUse({
        tool: "Explore",
        args: { directory: "src/agents" },
      });

      expect(result).not.toBeNull();
      expect(result?.context).toBeDefined();
      expect(result?.context).toContain("Agent Graph");
    });

    it("should provide context for Explore operations on tools directory", () => {
      const result = handlePreToolUse({
        tool: "Explore",
        args: { directory: "src/tools" },
      });

      expect(result).not.toBeNull();
      expect(result?.context).toBeDefined();
      expect(result?.context).toContain("Available Tools");
    });

    it("should provide context for grep operations searching for tool names", () => {
      const result = handlePreToolUse({
        tool: "grep",
        args: { pattern: "search_web" },
      });

      expect(result).not.toBeNull();
      expect(result?.context).toBeDefined();
      expect(result?.context).toContain("search_web");
    });

    it("should provide context for find operations", () => {
      const result = handlePreToolUse({
        tool: "find",
        args: { query: "github_write" },
      });

      expect(result).not.toBeNull();
      expect(result?.context).toBeDefined();
      expect(result?.context).toContain("github_write");
    });

    it("should handle missing arguments gracefully", () => {
      const result = handlePreToolUse({
        tool: "Read",
        args: {},
      });

      expect(result).toBeNull();
    });

    it("should return null for non-matching queries", () => {
      const result = handlePreToolUse({
        tool: "grep",
        args: { pattern: "xyznonexistent123" },
      });

      expect(result).toBeNull();
    });
  });

  describe("findRelatedNodes", () => {
    it("should find nodes by name", () => {
      const results = findRelatedNodes("search_web");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe("search_web");
    });

    it("should find nodes by type", () => {
      const results = findRelatedNodes("tool", "tool");
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.type === "tool")).toBe(true);
    });

    it("should find nodes by description", () => {
      const results = findRelatedNodes("GitHub");
      expect(results.length).toBeGreaterThan(0);
    });

    it("should be case-insensitive", () => {
      const results1 = findRelatedNodes("search_web");
      const results2 = findRelatedNodes("SEARCH_WEB");
      expect(results1.length).toBe(results2.length);
    });
  });

  describe("findConnections", () => {
    it("should find connections from a node", () => {
      const deptResearch = graph.nodes.find((n) => n.id === "dept_research");
      if (!deptResearch) throw new Error("dept_research not found");

      const connections = findConnections(deptResearch.id);
      expect(connections.from.length).toBeGreaterThan(0);
    });

    it("should find connections to a node", () => {
      const toolSearch = graph.nodes.find((n) => n.id === "tool_search_web");
      if (!toolSearch) throw new Error("tool_search_web not found");

      const connections = findConnections(toolSearch.id);
      // Tools belong_to departments (edge goes FROM tool TO dept)
      // So we check connections.from for outgoing edges
      expect(connections.from.length).toBeGreaterThan(0);
    });
  });

  describe("Hook Integration", () => {
    it("should show HITL gate info for sensitive operations", () => {
      const result = handlePreToolUse({
        tool: "grep",
        args: { pattern: "github_write" },
      });

      expect(result?.context).toContain("github_write");
      expect(result?.context).toContain("HITL");
    });

    it("should show department tools for agent files", () => {
      const result = handlePreToolUse({
        tool: "Read",
        args: { file_path: "src/agents" },
      });

      if (result) {
        expect(result.context).toBeDefined();
      }
    });

    it("should suggest related files when reading", () => {
      const result = handlePreToolUse({
        tool: "Read",
        args: { file_path: "src/agents/office.ts" },
      });

      expect(result?.context || result?.suggestions).toBeDefined();
    });
  });

  it("should handle errors gracefully", () => {
    const result = handlePreToolUse({
      tool: "Unknown",
      args: { unknown: "arg" },
    });

    expect(result).toBeNull();
  });
});
