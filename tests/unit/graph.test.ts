import { describe, it, expect } from "vitest";
import graph from "../../.claude/graph.json" with { type: "json" };

describe("Knowledge Graph (Graphify)", () => {
  it("should have all 8 departments (admin + 7 operational)", () => {
    const depts = graph.nodes.filter((n) => n.type === "department");
    expect(depts.length).toBe(8);
    expect(depts.map((d) => d.name).sort()).toEqual([
      "admin",
      "comms",
      "engineering",
      "jobhunt",
      "marketing",
      "personal",
      "research",
      "sales",
    ]);
  });

  it("should expose the current RAG / vector tools (2026-06-15 fix)", () => {
    const toolNames = graph.nodes.filter((n) => n.type === "tool").map((t) => t.name);
    expect(toolNames).toContain("search_turicks_brain");
    expect(toolNames).toContain("search_personal_rag");
    expect(toolNames).toContain("search_knowledge");
    expect(toolNames).toContain("publish_signal");
  });

  it("should include apply_cinematic_preset for engineering (2026-06-23 fix)", () => {
    const toolNames = graph.nodes.filter((n) => n.type === "tool").map((t) => t.name);
    expect(toolNames).toContain("apply_cinematic_preset");
    // It must be wired to engineering
    const edge = graph.edges.find(
      (e) => e.from === "tool_apply_cinematic_preset" && e.to === "dept_engineering" && e.type === "belongs_to"
    );
    expect(edge).toBeDefined();
  });

  it("should model the vector stores + Ollama as services", () => {
    const names = graph.nodes.filter((n) => n.type === "service").map((s) => s.name);
    expect(names.some((s) => /ollama/i.test(s))).toBe(true);
    expect(names.some((s) => /turicks_brain/i.test(s))).toBe(true);
    expect(names.some((s) => /personal_rag/i.test(s))).toBe(true);
  });

  it("should have all tools defined", () => {
    const tools = graph.nodes.filter((n) => n.type === "tool");
    const toolNames = tools.map((t) => t.name).sort();

    expect(toolNames).toContain("search_web");
    expect(toolNames).toContain("send_email");
    expect(toolNames).toContain("github_read");
    expect(toolNames).toContain("claude_code");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("run_shell");
    expect(toolNames).toContain("browser");
    expect(toolNames).toContain("send_file");
    expect(toolNames).toContain("read_cv");
  });

  it("should have core services", () => {
    const services = graph.nodes.filter((n) => n.type === "service");
    const serviceNames = services.map((s) => s.name);

    expect(serviceNames).toContain("Supervisor");
    expect(serviceNames).toContain("Telegram Gateway");
    expect(serviceNames.some((s) => s.includes("HITL"))).toBe(true);
    expect(serviceNames).toContain("PostgreSQL");
    expect(serviceNames).toContain("Redis");
  });

  it("should have metadata for all departments", () => {
    expect(Object.keys(graph.metadata.departments).length).toBe(8);
    expect(graph.metadata.departments.admin).toBeDefined();
    expect(graph.metadata.departments.research).toBeDefined();
    expect(graph.metadata.departments.comms).toBeDefined();
    expect(graph.metadata.departments.engineering).toBeDefined();
  });

  it("should have metadata for all tools", () => {
    expect(Object.keys(graph.metadata.tools).length).toBeGreaterThan(10);
    expect(graph.metadata.tools.search_web).toBeDefined();
    expect(graph.metadata.tools.send_email).toBeDefined();
  });

  it("should have valid edges", () => {
    graph.edges.forEach((edge) => {
      const fromNode = graph.nodes.find((n) => n.id === edge.from);
      const toNode = graph.nodes.find((n) => n.id === edge.to);

      expect(fromNode, `Edge from ${edge.from} references undefined node`).toBeDefined();
      expect(toNode, `Edge to ${edge.to} references undefined node`).toBeDefined();
    });
  });

  it("should have at least 40 edges", () => {
    expect(graph.edges.length).toBeGreaterThanOrEqual(40);
  });

  it("should have all departments connected to supervisor", () => {
    const depts = graph.nodes.filter((n) => n.type === "department");
    const supervisor = graph.nodes.find((n) => n.name === "Supervisor");

    depts.forEach((dept) => {
      const edge = graph.edges.find((e) => e.from === dept.id && e.to === supervisor?.id);
      expect(edge, `Department ${dept.name} not connected to Supervisor`).toBeDefined();
    });
  });

  it("should have all tools assigned to departments", () => {
    const tools = graph.nodes.filter((n) => n.type === "tool");

    tools.forEach((tool) => {
      // Tools belong_to departments (edge goes from tool TO department)
      const assignedToDept = graph.edges.some(
        (e) => e.from === tool.id && e.type === "belongs_to"
      );
      expect(assignedToDept, `Tool ${tool.name} not assigned to any department`).toBe(true);
    });
  });

  it("should validate HITL gates for sensitive tools", () => {
    const sensitiveTools = [
      "claude_code",
      "write_file",
      "run_shell",
      "browser",
      "send_file",
      "send_email",
      "linkedin_post",
    ];

    sensitiveTools.forEach((toolName) => {
      const tool = graph.nodes.find((n) => n.type === "tool" && n.name === toolName);
      expect(tool, `Sensitive tool ${toolName} missing from graph`).toBeDefined();
      expect(tool?.description).toMatch(/HITL|gated|approval/i);
    });
  });

  it("should have personal dept tools marked as HITL-gated", () => {
    const personalTools = [
      "write_file",
      "run_shell",
      "browser",
      "send_file",
    ];

    personalTools.forEach((toolName) => {
      const tool = graph.nodes.find((n) => n.type === "tool" && n.name === toolName);
      expect(tool?.description).toMatch(/HITL|gated|approval/i);
    });
  });

  it("should have read_file as ungated", () => {
    const readFile = graph.nodes.find((n) => n.name === "read_file");
    expect(readFile?.description).not.toMatch(/HITL|gated|approval/i);
  });

  it("should have no duplicate nodes", () => {
    const ids = graph.nodes.map((n) => n.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  it("should have no duplicate edges", () => {
    const edgeKeys = graph.edges.map((e) => `${e.from}→${e.to}`);
    const uniqueKeys = new Set(edgeKeys);
    expect(edgeKeys.length).toBe(uniqueKeys.size);
  });
});
