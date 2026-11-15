import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const order: string[] = [];
vi.mock("../../../src/tools/jobhunt/sweep-runner.js", () => ({
  FREE_SWEEP_CRON: "*/30 * * * *",
  runFreeSweep: vi.fn(async () => { order.push("sweep"); }),
}));
const runShadowApply = vi.fn(async () => { order.push("shadow"); return { routed: [], opened: 0 }; });
vi.mock("../../../src/tools/jobhunt/shadow-apply.js", async () => {
  const real = await vi.importActual<typeof import("../../../src/tools/jobhunt/shadow-apply.js")>("../../../src/tools/jobhunt/shadow-apply.js");
  return { ...real, runShadowApply };
});

const { JOBS_CRONS } = await import("../../../src/jobs/scheduler.js");
const freeSweep = JOBS_CRONS.find((c) => c.name === "free-sweep");

afterEach(() => {
  delete process.env["AUTO_APPLY_SHADOW"];
  order.length = 0;
  runShadowApply.mockClear();
});

describe("free-sweep cron and shadow apply", () => {
  it("runs the shadow pass after the sweep when AUTO_APPLY_SHADOW=on", async () => {
    process.env["AUTO_APPLY_SHADOW"] = "on";
    await freeSweep?.run();
    expect(order).toEqual(["sweep", "shadow"]);
  });
  it("runs only the sweep when the switch is off or unset", async () => {
    await freeSweep?.run();
    process.env["AUTO_APPLY_SHADOW"] = "off";
    await freeSweep?.run();
    expect(order).toEqual(["sweep", "sweep"]);
    expect(runShadowApply).not.toHaveBeenCalled();
  });
  it("a shadow failure does not reject the cron tick", async () => {
    process.env["AUTO_APPLY_SHADOW"] = "on";
    runShadowApply.mockRejectedValueOnce(new Error("db down"));
    await expect(freeSweep?.run()).resolves.toBeUndefined();
  });
});
