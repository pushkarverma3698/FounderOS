/**
 * Runtime Bootstrap — correct identity, objectives, permissions, manifest, no memory dump.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { CapabilityResolver } from "../../../src/workers/capabilities/resolver.js";
import { buildWorkerToolManifest } from "../../../src/workers/capabilities/manifest.js";
import { DefaultWorkerContextProvider } from "../../../src/workers/context/worker-context.js";
import { StubRuntimeAdapter } from "../../../src/workers/runtimes/stub.js";
import { WorkerLifecycleManager } from "../../../src/workers/lifecycle/manager.js";
import { ToolRegistry } from "../../../src/tools/registry/registry.js";
import { CAREER_OPERATOR_CONTRACT } from "../../../src/workers/contracts/career-operator.js";
import type { RuntimeBootstrapPacket } from "../../../src/workers/runtimes/types.js";
import type { ToolDefinition } from "../../../src/tools/registry/types.js";

function makeTool(id: string): ToolDefinition {
  return {
    id, name: id, description: `Tool ${id}`,
    layer: "integration", transport: "internal",
    inputSchema: { type: "object", properties: {} },
    sideEffect: "read", approval: "none", enabled: true,
  };
}

describe("RuntimeBootstrapPacket", () => {
  let registry: ToolRegistry;
  let resolver: CapabilityResolver;
  let contextProvider: DefaultWorkerContextProvider;
  let runtime: StubRuntimeAdapter;
  let lifecycle: WorkerLifecycleManager;

  beforeEach(() => {
    registry = new ToolRegistry();
    resolver = new CapabilityResolver();
    contextProvider = new DefaultWorkerContextProvider();
    runtime = new StubRuntimeAdapter();
    lifecycle = new WorkerLifecycleManager();

    // Register tools
    for (const id of ["search_jobs", "search_web", "send_email", "read_cv", "cv_gaps"]) {
      registry.register(makeTool(id));
    }

    // Register capability mappings
    resolver.registerMappings({
      "career.discovery": ["search_jobs", "search_web"],
      "career.research": ["search_web"],
      "career.outreach": ["send_email"],
      "career.applications": ["read_cv", "cv_gaps"],
      "career.contacts": [],
      "professional_presence": [],
    });

    contextProvider.registerContract(CAREER_OPERATOR_CONTRACT);
  });

  function buildBootstrap(): RuntimeBootstrapPacket {
    const manifest = buildWorkerToolManifest(CAREER_OPERATOR_CONTRACT, registry, resolver);
    return {
      workerId: CAREER_OPERATOR_CONTRACT.worker.id,
      contractVersion: CAREER_OPERATOR_CONTRACT.worker.contractVersion,
      identity: CAREER_OPERATOR_CONTRACT.identity,
      purpose: CAREER_OPERATOR_CONTRACT.purpose,
      responsibilities: CAREER_OPERATOR_CONTRACT.responsibilities,
      objectives: CAREER_OPERATOR_CONTRACT.objectives,
      constraints: CAREER_OPERATOR_CONTRACT.constraints,
      permissions: CAREER_OPERATOR_CONTRACT.permissions,
      toolManifest: manifest,
      contextRefs: CAREER_OPERATOR_CONTRACT.context.contextRefs,
    };
  }

  test("bootstrap contains correct worker identity", () => {
    const bp = buildBootstrap();
    expect(bp.workerId).toBe("career_operator");
    expect(bp.identity.represents).toBe("Pushkar");
    expect(bp.identity.role).toBe("Professional Opportunity Operator");
  });

  test("bootstrap contains objectives", () => {
    const bp = buildBootstrap();
    expect(bp.objectives.length).toBeGreaterThan(0);
    expect(bp.objectives[0]?.id).toBe("maintain_pipeline");
  });

  test("bootstrap contains permissions", () => {
    const bp = buildBootstrap();
    expect(bp.permissions.allowed.length).toBeGreaterThan(0);
    expect(bp.permissions.approvalRequired.length).toBeGreaterThan(0);
  });

  test("bootstrap contains scoped tool manifest (not full registry)", () => {
    const bp = buildBootstrap();
    const toolIds = bp.toolManifest.tools.map((t) => t.id);
    expect(toolIds.length).toBeGreaterThan(0);
    expect(toolIds.length).toBeLessThan(100); // Not the full registry
  });

  test("bootstrap contains context references, not raw data", () => {
    const bp = buildBootstrap();
    expect(bp.contextRefs.length).toBeGreaterThan(0);
    // Context refs are strings (references), not large blobs
    for (const ref of bp.contextRefs) {
      expect(typeof ref).toBe("string");
      expect(ref.length).toBeLessThan(1000);
    }
  });

  test("bootstrap does not contain large memory dumps", () => {
    const bp = buildBootstrap();
    const json = JSON.stringify(bp);
    // Bootstrap should be compact — well under 10KB
    expect(json.length).toBeLessThan(10_000);
  });

  test("stub runtime accepts bootstrap and tracks lifecycle", async () => {
    const bp = buildBootstrap();
    const handle = await runtime.start(CAREER_OPERATOR_CONTRACT, bp);

    expect(handle.workerId).toBe("career_operator");
    expect(handle.providerId).toBe("stub");

    const status = await runtime.getStatus(handle);
    expect(status.state).toBe("running");

    await runtime.sendTask(handle, {
      taskId: "task_1",
      description: "Search for senior engineering roles",
    });

    await runtime.pause(handle);
    expect((await runtime.getStatus(handle)).state).toBe("idle");

    await runtime.resume(handle);
    expect((await runtime.getStatus(handle)).state).toBe("running");

    await runtime.stop(handle);
    expect((await runtime.getStatus(handle)).state).toBe("stopped");

    // Verify event log
    expect(runtime.log.length).toBe(5); // start, task, pause, resume, stop
    expect(runtime.log[0]?.event).toBe("start");
    expect(runtime.log[1]?.event).toBe("task");
  });

  test("worker context can be reconstructed after runtime restart", async () => {
    // Simulate runtime crash + restart
    const bp1 = buildBootstrap();
    const handle1 = await runtime.start(CAREER_OPERATOR_CONTRACT, bp1);
    await runtime.stop(handle1);

    // New runtime adapter (simulating restart)
    const runtime2 = new StubRuntimeAdapter();
    const bp2 = buildBootstrap();
    const handle2 = await runtime2.start(CAREER_OPERATOR_CONTRACT, bp2);

    expect(handle2.workerId).toBe("career_operator");
    expect((await runtime2.getStatus(handle2)).state).toBe("running");
    expect(bp2.identity.role).toBe("Professional Opportunity Operator");
    expect(bp2.objectives.length).toBeGreaterThan(0);
  });

  test("lifecycle manager tracks state through bootstrap flow", () => {
    lifecycle.create(CAREER_OPERATOR_CONTRACT);
    lifecycle.configure("career_operator");
    lifecycle.ready("career_operator");
    lifecycle.start("career_operator");

    const state = lifecycle.getState("career_operator");
    expect(state?.status).toBe("RUNNING");

    lifecycle.fail("career_operator", "runtime crashed");
    expect(lifecycle.getState("career_operator")?.status).toBe("FAILED");

    // Re-create and restart
    lifecycle.create(CAREER_OPERATOR_CONTRACT);
    lifecycle.configure("career_operator");
    lifecycle.ready("career_operator");
    lifecycle.start("career_operator");
    expect(lifecycle.getState("career_operator")?.status).toBe("RUNNING");
  });
});
