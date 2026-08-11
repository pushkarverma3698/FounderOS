import { describe, it, expect } from "vitest";
import {
  findNodesByType,
  findNodeByName,
  findEdgesFrom,
  findEdgesTo,
  findToolsByDepartment,
  findDepartmentsByTool,
  findAgentsByDepartment,
  getGraphSummary,
} from "../../scripts/graph-query-helper.js";

// These tests guard against the 2026-06-23 regression where findToolsByDepartment
// and findDepartmentsByTool always returned [] because they queried the wrong edge
// direction (FROM dept TO tool with type "uses_tool") instead of the actual edge
// direction (FROM tool TO dept with type "belongs_to").

describe("graph-query-helper — findToolsByDepartment", () => {
  it("returns tools for research department", () => {
    const tools = findToolsByDepartment("research");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toContain("search_web");
    expect(tools).toContain("search_knowledge");
    expect(tools).toContain("search_turicks_brain");
    expect(tools).toContain("publish_signal");
  });

  it("returns tools for engineering department", () => {
    const tools = findToolsByDepartment("engineering");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toContain("github_read");
    expect(tools).not.toContain("github_write");
    expect(tools).toContain("claude_code");
    expect(tools).toContain("apply_cinematic_preset");
    expect(tools).toContain("deploy_static_site");
  });

  it("returns tools for personal department", () => {
    const tools = findToolsByDepartment("personal");
    expect(tools).toContain("read_file");
    expect(tools).toContain("run_shell");
    expect(tools).toContain("browser");
  });

  it("returns tools for comms department", () => {
    const tools = findToolsByDepartment("comms");
    expect(tools).toContain("send_email");
    expect(tools).toContain("read_emails");
    expect(tools).toContain("create_calendar_event");
  });

  it("returns empty array for unknown department", () => {
    const tools = findToolsByDepartment("prospecting"); // deleted department
    expect(tools).toEqual([]);
  });

  it("never returns empty for any live department", () => {
    const depts = ["admin", "research", "comms", "engineering", "marketing", "sales", "personal", "jobhunt"];
    depts.forEach((dept) => {
      const tools = findToolsByDepartment(dept);
      expect(tools.length, `${dept} should have tools`).toBeGreaterThan(0);
    });
  });
});

describe("graph-query-helper — findDepartmentsByTool", () => {
  it("finds all departments that use search_web", () => {
    const depts = findDepartmentsByTool("search_web");
    expect(depts.length).toBeGreaterThan(0);
    expect(depts).toContain("research");
    expect(depts).toContain("marketing");
    expect(depts).toContain("sales");
    // prospecting was deleted — must NOT appear
    expect(depts).not.toContain("prospecting");
  });

  it("finds departments that use send_email (comms, sales, jobhunt)", () => {
    const depts = findDepartmentsByTool("send_email");
    expect(depts).toContain("comms");
    expect(depts).toContain("sales");
    expect(depts).toContain("jobhunt");
  });

  it("finds engineering as the sole user of apply_cinematic_preset", () => {
    const depts = findDepartmentsByTool("apply_cinematic_preset");
    expect(depts).toContain("engineering");
    // Cinematic preset is engineering-only
    expect(depts.every((d: string) => d === "engineering")).toBe(true);
  });

  it("finds personal for search_personal_rag", () => {
    const depts = findDepartmentsByTool("search_personal_rag");
    expect(depts).toContain("personal");
    expect(depts).not.toContain("jobhunt");
  });

  it("returns empty array for non-existent tool", () => {
    const depts = findDepartmentsByTool("xyznonexistent");
    expect(depts).toEqual([]);
  });
});

describe("graph-query-helper — other functions", () => {
  it("findNodesByType returns all departments", () => {
    const depts = findNodesByType("department");
    expect(depts.length).toBe(8);
  });

  it("findNodesByType returns all tools in graph", () => {
    const tools = findNodesByType("tool");
    expect(tools.length).toBeGreaterThanOrEqual(30);
  });

  it("findNodeByName finds search_web", () => {
    const node = findNodeByName("search_web");
    expect(node).toBeDefined();
    expect(node?.type).toBe("tool");
  });

  it("findNodeByName is case-insensitive", () => {
    const lower = findNodeByName("github_read");
    const upper = findNodeByName("GITHUB_READ");
    expect(lower?.id).toBe(upper?.id);
  });

  it("findEdgesFrom returns edges going out from dept_research", () => {
    const edges = findEdgesFrom("dept_research");
    expect(edges.length).toBeGreaterThan(0);
    // research department calls supervisor
    expect(edges.some((e: any) => e.to === "service_supervisor")).toBe(true);
  });

  it("findEdgesTo returns edges pointing to dept_engineering", () => {
    const edges = findEdgesTo("dept_engineering");
    expect(edges.length).toBeGreaterThan(0);
    // engineering agent belongs_to engineering dept
    expect(edges.some((e: any) => e.from === "agent_engineering_agent")).toBe(true);
  });

  it("findAgentsByDepartment returns the ReAct agent for each dept", () => {
    const agents = findAgentsByDepartment("marketing");
    expect(agents).toContain("marketing_agent");
  });

  it("getGraphSummary includes department count", () => {
    const summary = getGraphSummary();
    expect(summary).toContain("8");
    expect(summary).toContain("Departments");
  });
});
