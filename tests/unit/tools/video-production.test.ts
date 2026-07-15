/**
 * Video Factory — production plan + receipt-derived state tests ($0, pure).
 * The Antigravity core: immutable plan, state derived from receipts, bounded
 * retries, stale receipts self-invalidate, failures name the component.
 */

import { describe, it, expect } from "vitest";
import { loadBrand, type BrandProfile } from "../../../src/tools/video-brand.js";
import { compileShotList } from "../../../src/tools/video-shotlist.js";
import { planModels } from "../../../src/tools/video-models.js";
import {
  compileProductionPlan,
  deriveStatus,
  stepKey,
  ProductionPlanSchema,
  MAX_ATTEMPTS,
  type ProductionPlan,
  type StepReceipt,
} from "../../../src/tools/video-production.js";

function makePlan(voScript?: string, includeMusic = true): ProductionPlan {
  const res = loadBrand("the-health-place");
  if (!res.success) throw new Error(res.error);
  const shotlist = compileShotList(res.brand as BrandProfile, { format: "reel-9x16", topic: "t", duration_s: 30 });
  const models = planModels(shotlist);
  return compileProductionPlan(shotlist, models, {
    project: "thp--t--reel-9x16",
    ...(voScript ? { vo_script: voScript } : {}),
    include_music: includeMusic,
  });
}

function okReceipt(plan: ProductionPlan, id: string): StepReceipt {
  const step = plan.steps.find((s) => s.id === id)!;
  return { step_id: id, key: stepKey(step), ok: true, attempts: 1 };
}

describe("compileProductionPlan", () => {
  it("is deterministic and schema-valid (round-trips through JSON)", () => {
    const a = makePlan("hello world");
    const b = makePlan("hello world");
    expect(a).toEqual(b);
    expect(ProductionPlanSchema.parse(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });

  it("every generated asset is gated by a probe before compositing", () => {
    const plan = makePlan("script", true);
    const composite = plan.steps.find((s) => s.id === "composite")!;
    for (const gen of plan.steps.filter((s) => s.kind === "veo" || s.kind === "hyperframes")) {
      const verify = plan.steps.find((s) => s.kind === "probe" && s.needs.includes(gen.id));
      expect(verify, `${gen.id} must have a verify probe`).toBeDefined();
      expect(composite.needs).toContain(verify!.id);
    }
  });

  it("steps are topologically ordered (deps always come earlier)", () => {
    const plan = makePlan("script");
    const seen = new Set<string>();
    for (const step of plan.steps) {
      for (const d of step.needs) expect(seen.has(d), `${step.id} needs ${d} before it`).toBe(true);
      seen.add(step.id);
    }
  });

  it("VO gets a fits-the-timeline probe with a remedy (fail loud, never stretch)", () => {
    const plan = makePlan("a short script");
    const verifyVo = plan.steps.find((s) => s.id === "verify-vo")!;
    expect(verifyVo.params["max_duration_s"]).toBe(29.5);
    expect(String(verifyVo.params["remedy"])).toContain("shorten the script");
  });

  it("final QA pins duration ±0.5s and exact canvas", () => {
    const plan = makePlan();
    const qa = plan.steps.find((s) => s.id === "qa-final")!;
    expect(qa.params).toMatchObject({ min_duration_s: 29.5, max_duration_s: 30.5, width: 1080, height: 1920 });
  });

  it("omits VO/music steps when not requested", () => {
    const plan = makePlan(undefined, false);
    expect(plan.steps.find((s) => s.kind === "elevenlabs-vo")).toBeUndefined();
    expect(plan.steps.find((s) => s.kind === "elevenlabs-music")).toBeUndefined();
  });
});

describe("deriveStatus (receipts = state)", () => {
  it("fresh production: generation steps ready, composite blocked, phase generating", () => {
    const plan = makePlan("script");
    const status = deriveStatus(plan, {});
    expect(status.phase).toBe("generating");
    const byId = new Map(status.steps.map((s) => [s.id, s]));
    expect(byId.get("vendor-gsap")?.status).toBe("ready");
    expect(byId.get("composite")?.status).toBe("blocked");
    expect(status.pending_cost_usd).toBeGreaterThan(0);
    expect(status.next).toContain("vendor-gsap");
  });

  it("all receipts valid → delivered, nothing pending", () => {
    const plan = makePlan("script");
    const receipts = Object.fromEntries(plan.steps.map((s) => [s.id, okReceipt(plan, s.id)]));
    const status = deriveStatus(plan, receipts);
    expect(status.phase).toBe("delivered");
    expect(status.next).toEqual([]);
    expect(status.pending_cost_usd).toBe(0);
  });

  it("stale receipt (plan changed → key mismatch) self-invalidates: step re-runs", () => {
    const plan = makePlan("script");
    const receipts = { "vendor-gsap": { ...okReceipt(plan, "vendor-gsap"), key: "deadbeef" } };
    const status = deriveStatus(plan, receipts);
    expect(status.steps.find((s) => s.id === "vendor-gsap")?.status).toBe("ready");
  });

  it("bounded retries: one failure → still ready; MAX_ATTEMPTS failures → terminal, phase failed, component named", () => {
    const plan = makePlan();
    const gen = plan.steps.find((s) => s.kind === "veo")!;
    const once: StepReceipt = { step_id: gen.id, key: stepKey(gen), ok: false, attempts: 1, error: "Veo start failed: 503" };
    expect(deriveStatus(plan, { [gen.id]: once }).steps.find((s) => s.id === gen.id)?.status).toBe("ready");

    const terminal: StepReceipt = { ...once, attempts: MAX_ATTEMPTS };
    const status = deriveStatus(plan, { [gen.id]: terminal });
    expect(status.phase).toBe("failed");
    expect(status.failures).toEqual([{ step_id: gen.id, kind: "veo", attempts: MAX_ATTEMPTS, error: "Veo start failed: 503" }]);
    // downstream verify is blocked, not retried into a loop
    expect(status.steps.find((s) => s.id === `verify-${gen.id.replace("gen-", "")}`)?.status).toBe("blocked");
  });

  it("assets done → phase compositing", () => {
    const plan = makePlan();
    const receipts: Record<string, StepReceipt> = {};
    for (const s of plan.steps) {
      if (s.kind === "veo" || s.kind === "hyperframes" || s.kind === "elevenlabs-music" || s.id.startsWith("verify-") || s.id === "vendor-gsap") {
        receipts[s.id] = okReceipt(plan, s.id);
      }
    }
    expect(deriveStatus(plan, receipts).phase).toBe("compositing");
  });

  it("stepKey is stable across JSON round-trips (executor parity)", () => {
    const plan = makePlan("script");
    const roundTripped = ProductionPlanSchema.parse(JSON.parse(JSON.stringify(plan)));
    for (let i = 0; i < plan.steps.length; i++) {
      expect(stepKey(roundTripped.steps[i]!)).toBe(stepKey(plan.steps[i]!));
    }
  });
});
