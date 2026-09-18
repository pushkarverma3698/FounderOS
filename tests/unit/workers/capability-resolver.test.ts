/**
 * Capability Resolver — tool mapping, permission filtering, denied capabilities.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { CapabilityResolver } from "../../../src/workers/capabilities/resolver.js";
import { DEFAULT_CAPABILITY_MAPPINGS } from "../../../src/workers/capabilities/mappings.js";
import type { WorkerPermissions } from "../../../src/workers/contracts/types.js";

describe("CapabilityResolver", () => {
  let resolver: CapabilityResolver;

  beforeEach(() => {
    resolver = new CapabilityResolver();
    resolver.registerMappings({
      "career.discovery": ["search_jobs", "search_web"],
      "career.research": ["search_web", "scrape_url", "search_memory"],
      "career.outreach": ["send_email"],
      "admin.dangerous": ["delete_database"],
    });
  });

  test("resolves a single capability to tool IDs", () => {
    const tools = resolver.getToolsForCapability("career.discovery");
    expect(tools).toEqual(["search_jobs", "search_web"]);
  });

  test("resolves multiple capabilities with deduplication", () => {
    const tools = resolver.resolveCapabilities(["career.discovery", "career.research"]);
    // search_web appears in both — should be deduplicated
    expect(tools).toContain("search_jobs");
    expect(tools).toContain("search_web");
    expect(tools).toContain("scrape_url");
    expect(tools).toContain("search_memory");
    expect(new Set(tools).size).toBe(tools.length);
  });

  test("returns empty for unmapped capability", () => {
    const tools = resolver.getToolsForCapability("nonexistent.capability");
    expect(tools).toEqual([]);
  });

  test("silently skips unmapped capabilities in bulk resolve", () => {
    const tools = resolver.resolveCapabilities(["career.discovery", "nonexistent"]);
    expect(tools).toEqual(["search_jobs", "search_web"]);
  });

  test("excludes denied capabilities from resolution", () => {
    const perms: WorkerPermissions = {
      allowed: ["career.discovery", "career.research"],
      approvalRequired: ["career.outreach"],
      denied: ["admin.dangerous"],
    };
    const tools = resolver.resolveWithPermissions(
      ["career.discovery", "career.research", "admin.dangerous"],
      perms,
    );
    expect(tools).not.toContain("delete_database");
    expect(tools).toContain("search_jobs");
  });

  test("approval-required capabilities are still resolved", () => {
    const perms: WorkerPermissions = {
      allowed: [],
      approvalRequired: ["career.outreach"],
      denied: [],
    };
    const tools = resolver.resolveWithPermissions(["career.outreach"], perms);
    expect(tools).toContain("send_email");
  });

  test("hasMapping returns true for registered capabilities", () => {
    expect(resolver.hasMapping("career.discovery")).toBe(true);
    expect(resolver.hasMapping("nonexistent")).toBe(false);
  });

  test("listCapabilities returns all registered keys", () => {
    const caps = resolver.listCapabilities();
    expect(caps).toContain("career.discovery");
    expect(caps).toContain("career.research");
    expect(caps).toContain("career.outreach");
    expect(caps).toContain("admin.dangerous");
  });

  test("DEFAULT_CAPABILITY_MAPPINGS has career domain entries", () => {
    expect(DEFAULT_CAPABILITY_MAPPINGS["career.discovery"]).toBeDefined();
    expect(DEFAULT_CAPABILITY_MAPPINGS["career.research"]).toBeDefined();
    expect(DEFAULT_CAPABILITY_MAPPINGS["career.applications"]).toBeDefined();
  });

  test("last registerMapping write wins for same capability", () => {
    resolver.registerMapping("career.discovery", ["new_tool"]);
    expect(resolver.getToolsForCapability("career.discovery")).toEqual(["new_tool"]);
  });
});
