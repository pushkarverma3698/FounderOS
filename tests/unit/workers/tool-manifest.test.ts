/**
 * Worker Tool Manifest — scoping, transport stripping, permission enforcement.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { buildWorkerToolManifest } from "../../../src/workers/capabilities/manifest.js";
import { CapabilityResolver } from "../../../src/workers/capabilities/resolver.js";
import { ToolRegistry } from "../../../src/tools/registry/registry.js";
import { CAREER_OPERATOR_CONTRACT } from "../../../src/workers/contracts/career-operator.js";
import type { ToolDefinition } from "../../../src/tools/registry/types.js";

function makeTool(id: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id,
    name: id,
    description: `Tool ${id}`,
    layer: "integration",
    transport: "internal",
    inputSchema: { type: "object", properties: {} },
    sideEffect: "read",
    approval: "none",
    enabled: true,
    ...overrides,
  };
}

describe("WorkerToolManifest", () => {
  let registry: ToolRegistry;
  let resolver: CapabilityResolver;

  beforeEach(() => {
    registry = new ToolRegistry();
    resolver = new CapabilityResolver();

    // Register tools
    registry.register(makeTool("search_jobs"));
    registry.register(makeTool("search_web"));
    registry.register(makeTool("send_email", { sideEffect: "write", approval: "required" }));
    registry.register(makeTool("read_cv"));
    registry.register(makeTool("cv_gaps"));
    registry.register(makeTool("delete_database", { sideEffect: "destructive" }));
    registry.register(makeTool("disabled_tool", { enabled: false }));

    // Register capability mappings
    resolver.registerMappings({
      "career.discovery": ["search_jobs", "search_web"],
      "career.research": ["search_web"],
      "career.outreach": ["send_email"],
      "career.applications": ["read_cv", "cv_gaps"],
      "professional_presence": [],
      "admin.dangerous": ["delete_database"],
      "broken.cap": ["disabled_tool", "nonexistent_tool"],
    });
  });

  test("builds manifest with correct worker identity", () => {
    const manifest = buildWorkerToolManifest(CAREER_OPERATOR_CONTRACT, registry, resolver);
    expect(manifest.workerId).toBe("career_operator");
    expect(manifest.contractVersion).toBe("1.0.0");
  });

  test("includes only tools from worker capabilities", () => {
    const manifest = buildWorkerToolManifest(CAREER_OPERATOR_CONTRACT, registry, resolver);
    const toolIds = manifest.tools.map((t) => t.id);
    expect(toolIds).toContain("search_jobs");
    expect(toolIds).toContain("search_web");
    expect(toolIds).toContain("send_email");
    expect(toolIds).toContain("read_cv");
    // delete_database is not in the career operator's capabilities
    expect(toolIds).not.toContain("delete_database");
  });

  test("does not include transport details in manifest entries", () => {
    const manifest = buildWorkerToolManifest(CAREER_OPERATOR_CONTRACT, registry, resolver);
    for (const entry of manifest.tools) {
      // Manifest entries should NOT have transport, layer, executorRef, etc.
      expect(entry).not.toHaveProperty("transport");
      expect(entry).not.toHaveProperty("layer");
      expect(entry).not.toHaveProperty("executorRef");
      expect(entry).not.toHaveProperty("metadata");
      // But SHOULD have these
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("description");
      expect(entry).toHaveProperty("inputSchema");
      expect(entry).toHaveProperty("sideEffect");
      expect(entry).toHaveProperty("approval");
    }
  });

  test("preserves approval metadata in manifest", () => {
    const manifest = buildWorkerToolManifest(CAREER_OPERATOR_CONTRACT, registry, resolver);
    const emailTool = manifest.tools.find((t) => t.id === "send_email");
    expect(emailTool?.approval).toBe("required");
    expect(emailTool?.sideEffect).toBe("write");
  });

  test("excludes disabled tools from manifest", () => {
    // Create a contract that requests the broken capability
    const contract = {
      ...CAREER_OPERATOR_CONTRACT,
      capabilities: ["broken.cap"],
      permissions: { allowed: ["broken.cap"], approvalRequired: [], denied: [] },
    };
    const manifest = buildWorkerToolManifest(contract, registry, resolver);
    const toolIds = manifest.tools.map((t) => t.id);
    expect(toolIds).not.toContain("disabled_tool");
  });

  test("reports missing tool IDs", () => {
    const contract = {
      ...CAREER_OPERATOR_CONTRACT,
      capabilities: ["broken.cap"],
      permissions: { allowed: ["broken.cap"], approvalRequired: [], denied: [] },
    };
    const manifest = buildWorkerToolManifest(contract, registry, resolver);
    expect(manifest.missingToolIds).toContain("nonexistent_tool");
  });

  test("reports unmapped capabilities", () => {
    const contract = {
      ...CAREER_OPERATOR_CONTRACT,
      capabilities: ["career.discovery", "future.capability"],
      permissions: { allowed: ["career.discovery", "future.capability"], approvalRequired: [], denied: [] },
    };
    const manifest = buildWorkerToolManifest(contract, registry, resolver);
    expect(manifest.unmappedCapabilities).toContain("future.capability");
  });

  test("denied capabilities produce no tools", () => {
    const contract = {
      ...CAREER_OPERATOR_CONTRACT,
      capabilities: ["career.discovery", "admin.dangerous"],
      permissions: {
        allowed: ["career.discovery"],
        approvalRequired: [],
        denied: ["admin.dangerous"],
      },
    };
    const manifest = buildWorkerToolManifest(contract, registry, resolver);
    const toolIds = manifest.tools.map((t) => t.id);
    expect(toolIds).not.toContain("delete_database");
    expect(toolIds).toContain("search_jobs");
  });
});
