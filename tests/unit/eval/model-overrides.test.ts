/**
 * AG-031 part 2: "pnpm eval --planner-model <id> --worker-model <id>".
 *
 * The overrides must reach the SAME parseModelId/buildModel path production uses
 * (src/agents/model.ts), for one run, and fail loudly when they did not take
 * effect: an A/B whose "Claude" row was really answered by a fallback is worse
 * than no A/B. Everything here is 0 dollars: dummy keys, no network, no kernel.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseOverrideArgs,
  overrideEnvPatch,
  applyOverrides,
  assertOverridesApplied,
  assertResponseCacheOff,
} from "../../../src/eval/model-overrides.js";
import { getModel, getWorkerModel, getConfiguredModelId } from "../../../src/agents/model.js";
import { describeStageModels, resetWorkerModelChoiceForTests } from "../../../src/agents/model-truth.js";

const SONNET = "anthropic:claude-sonnet-5-5";
const FLASH = "google-genai:gemini-3.6-flash";

describe("parseOverrideArgs", () => {
  it("returns no overrides when neither flag is given (baseline = prod config)", () => {
    expect(parseOverrideArgs(["--suite", "understanding"])).toEqual({});
  });

  it("reads both flags in the two-argument form and ignores unrelated args", () => {
    const argv = ["--suite", "understanding", "--planner-model", SONNET, "--worker-model", FLASH];
    expect(parseOverrideArgs(argv)).toEqual({ plannerModel: SONNET, workerModel: FLASH });
  });

  it("reads the --flag=value form", () => {
    expect(parseOverrideArgs(["--planner-model=" + SONNET])).toEqual({ plannerModel: SONNET });
  });

  it("resolves an id through parseModelId, so a bare Claude id gets its provider prefix", () => {
    expect(parseOverrideArgs(["--worker-model", "claude-sonnet-5-5"])).toEqual({ workerModel: SONNET });
  });

  it("rejects a missing value, a flag mistaken for a value, and a repeated flag", () => {
    expect(() => parseOverrideArgs(["--planner-model"])).toThrow(/--planner-model needs a model id/);
    expect(() => parseOverrideArgs(["--planner-model", "--worker-model", FLASH])).toThrow(/--planner-model needs a model id/);
    expect(() => parseOverrideArgs(["--worker-model", FLASH, "--worker-model", SONNET])).toThrow(/given more than once/);
  });

  it("rejects an id production could not parse, naming the flag", () => {
    expect(() => parseOverrideArgs(["--worker-model", "bogus:model-x"])).toThrow(/--worker-model.*Unsupported/s);
  });
});

describe("overrideEnvPatch", () => {
  it("is empty without overrides, so the baseline runs the unmodified prod env", () => {
    expect(overrideEnvPatch({})).toEqual({});
  });

  it("maps the flags to the env vars model.ts reads", () => {
    const patch = overrideEnvPatch({ plannerModel: SONNET, workerModel: FLASH });
    expect(patch["AGENT_MODEL"]).toBe(SONNET);
    expect(patch["WORKER_AGENT_MODEL"]).toBe(FLASH);
  });

  it("leaves the other stage's env var alone when only one flag is given", () => {
    const patch = overrideEnvPatch({ plannerModel: SONNET });
    expect(patch).not.toHaveProperty("WORKER_AGENT_MODEL");
  });

  it("empties every fallback chain, so a failing model is a loud infra error and not a silent swap", () => {
    const patch = overrideEnvPatch({ workerModel: FLASH });
    expect(patch["AGENT_FALLBACK_MODELS"]).toBe("");
    expect(patch["PLANNER_FALLBACK_MODELS"]).toBe("");
    expect(patch["WORKER_FALLBACK_MODELS"]).toBe("");
  });
});

describe("applyOverrides", () => {
  it("writes the patch into the given env and nowhere else", () => {
    const env: NodeJS.ProcessEnv = { AGENT_MODEL: "google-genai:gemini-3.8-flash", WORKER_FALLBACK_MODELS: "openrouter:x/y" };
    applyOverrides(env, { plannerModel: SONNET });
    expect(env["AGENT_MODEL"]).toBe(SONNET);
    expect(env["WORKER_FALLBACK_MODELS"]).toBe("");
  });
});

describe("assertOverridesApplied", () => {
  const stages = (planner: string, worker: string) => ({ planner, worker, synthesizer: worker });

  it("passes when every requested stage resolved to the requested model", () => {
    expect(() => assertOverridesApplied({ plannerModel: SONNET, workerModel: FLASH }, stages(SONNET, FLASH))).not.toThrow();
  });

  it("does nothing for the baseline", () => {
    expect(() => assertOverridesApplied({}, stages("a:b", "c:d"))).not.toThrow();
  });

  it("throws when the worker silently fell back, and says why", () => {
    expect(() => assertOverridesApplied({ workerModel: SONNET }, stages(FLASH, FLASH), {})).toThrow(
      /--worker-model anthropic:claude-sonnet-5-5.*resolved to google-genai:gemini-3.6-flash.*ANTHROPIC_API_KEY is not set/s,
    );
  });

  it("throws when the worker stage never resolved", () => {
    expect(() => assertOverridesApplied({ workerModel: FLASH }, stages(SONNET, "unresolved"))).toThrow(/resolved to unresolved/);
  });

  it("throws when the planner is not the requested model", () => {
    expect(() => assertOverridesApplied({ plannerModel: SONNET }, stages(FLASH, FLASH))).toThrow(/--planner-model/);
  });
});

describe("assertResponseCacheOff", () => {
  it("refuses an eval run with the LLM response cache on: hits skip the model and fake the latency and cost", () => {
    expect(() => assertResponseCacheOff({ LLM_CACHE_ENABLED: "true" })).toThrow(/LLM_CACHE_ENABLED/);
  });

  it("accepts it unset or false", () => {
    expect(() => assertResponseCacheOff({})).not.toThrow();
    expect(() => assertResponseCacheOff({ LLM_CACHE_ENABLED: "false" })).not.toThrow();
  });
});

describe("overrides reach the production model path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetWorkerModelChoiceForTests();
  });

  it("makes getModel/getWorkerModel build the requested providers, and the stage report names them", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "dummy-not-a-real-key");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "dummy-not-a-real-key");
    vi.stubEnv("AGENT_MODEL", "google-genai:gemini-3.8-flash");
    vi.stubEnv("WORKER_AGENT_MODEL", "");
    applyOverrides(process.env, { plannerModel: SONNET, workerModel: FLASH });

    const planner = getModel();
    getWorkerModel();

    expect(planner.constructor.name).toBe("ChatAnthropic");
    expect(getConfiguredModelId()).toBe(SONNET);
    const stages = describeStageModels(getConfiguredModelId());
    expect(stages).toEqual({ planner: SONNET, worker: FLASH, synthesizer: FLASH });
    expect(() => assertOverridesApplied({ plannerModel: SONNET, workerModel: FLASH }, stages)).not.toThrow();
  });

  it("detects a worker override that silently fell back because its key is missing", () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "dummy-not-a-real-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AGENT_MODEL", FLASH);
    applyOverrides(process.env, { workerModel: SONNET });

    getWorkerModel();
    const stages = describeStageModels(getConfiguredModelId());

    expect(stages.worker).toBe(FLASH);
    expect(() => assertOverridesApplied({ workerModel: SONNET }, stages)).toThrow(/ANTHROPIC_API_KEY is not set/);
  });
});
