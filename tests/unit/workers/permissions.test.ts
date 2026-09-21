/**
 * Worker Permissions — allowed, denied, approval-required capability enforcement.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { CapabilityResolver } from "../../../src/workers/capabilities/resolver.js";
import type { WorkerPermissions } from "../../../src/workers/contracts/types.js";

describe("Worker permissions enforcement", () => {
  let resolver: CapabilityResolver;

  beforeEach(() => {
    resolver = new CapabilityResolver();
    resolver.registerMappings({
      "career.discovery": ["search_jobs", "search_web"],
      "career.outreach": ["send_email"],
      "admin.system": ["deploy_production", "manage_server"],
      "admin.data": ["delete_database"],
    });
  });

  test("allowed capabilities are resolved", () => {
    const perms: WorkerPermissions = {
      allowed: ["career.discovery"],
      approvalRequired: [],
      denied: [],
    };
    const tools = resolver.resolveWithPermissions(["career.discovery"], perms);
    expect(tools).toContain("search_jobs");
    expect(tools).toContain("search_web");
  });

  test("denied capabilities produce zero tools", () => {
    const perms: WorkerPermissions = {
      allowed: [],
      approvalRequired: [],
      denied: ["admin.data"],
    };
    const tools = resolver.resolveWithPermissions(["admin.data"], perms);
    expect(tools).toEqual([]);
  });

  test("denied capability is excluded even if also listed in allowed", () => {
    const perms: WorkerPermissions = {
      allowed: ["admin.data"],
      approvalRequired: [],
      denied: ["admin.data"],
    };
    const tools = resolver.resolveWithPermissions(["admin.data"], perms);
    expect(tools).toEqual([]);
  });

  test("approval-required capabilities are resolved (enforcement at gateway)", () => {
    const perms: WorkerPermissions = {
      allowed: [],
      approvalRequired: ["career.outreach"],
      denied: [],
    };
    const tools = resolver.resolveWithPermissions(["career.outreach"], perms);
    expect(tools).toContain("send_email");
  });

  test("mixed permissions: some allowed, some denied", () => {
    const perms: WorkerPermissions = {
      allowed: ["career.discovery"],
      approvalRequired: ["career.outreach"],
      denied: ["admin.system", "admin.data"],
    };
    const tools = resolver.resolveWithPermissions(
      ["career.discovery", "career.outreach", "admin.system", "admin.data"],
      perms,
    );
    expect(tools).toContain("search_jobs");
    expect(tools).toContain("send_email");
    expect(tools).not.toContain("deploy_production");
    expect(tools).not.toContain("manage_server");
    expect(tools).not.toContain("delete_database");
  });

  test("worker cannot elevate permissions through ordinary tools", () => {
    // The resolver only reads the permissions — it has no API to modify them.
    // Permission changes belong to FounderOS control plane logic.
    const perms: WorkerPermissions = {
      allowed: ["career.discovery"],
      approvalRequired: [],
      denied: ["admin.system"],
    };
    const tools = resolver.resolveWithPermissions(
      ["career.discovery", "admin.system"],
      perms,
    );
    expect(tools).not.toContain("deploy_production");
    // Verify resolver has no mutation API
    expect(typeof (resolver as unknown as Record<string, unknown>)["setPermissions"]).toBe("undefined");
  });
});
