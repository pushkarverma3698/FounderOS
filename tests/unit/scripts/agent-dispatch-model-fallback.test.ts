/**
 * agent-dispatch must survive a retired executor model: deploy/agent-dispatch, deploy/lib/agy-run.sh.
 * ====================================================================
 * agy answers a model name its catalog no longer has with exit 1 and "invalid model selection ... is not
 * recognized as a known model". pr-brain already skips such a reviewer (agy_model_unknown); the executor did not:
 * the issue ended agent:failed on a run that never started. AGENT_DISPATCH_MODELS is the candidate list; the next
 * candidate re-runs the SAME attempt, and a retired name is not a failed attempt.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DispatchSandbox } from "./dispatch-sandbox.js";

let sb: DispatchSandbox;

beforeEach(() => {
  sb = new DispatchSandbox(["owner/founderos"]);
  sb.addIssue({ number: 810, title: "test(docs): add visible test comment" });
});

afterEach(() => {
  sb.destroy();
});

describe("agent-dispatch: executor model candidates", () => {
  it("a retired first model falls through to the next candidate in the same attempt", () => {
    sb.tick({
      agyOut: "Error: something else broke",
      env: { AGENT_DISPATCH_MODELS: "old-model new-model", AGY_UNKNOWN_MODELS: "old-model" },
    });

    expect(sb.agyModels()).toEqual(["old-model", "new-model"]);
    // the second run failed for an ordinary reason: that, not the retired name, is what the issue records
    expect(sb.ghLog()).toMatch(/--add-label agent:failed/);
    expect(sb.log()).toMatch(/old-model is not a model agy knows/);
  });

  it("warns once, naming the retired model and the fix, and not again on the next tick", () => {
    const env = { AGENT_DISPATCH_MODELS: "old-model new-model", AGY_UNKNOWN_MODELS: "old-model" };
    sb.tick({ agyOut: "Error: something else broke", env });
    sb.addIssue({ number: 811, title: "test(docs): second visible test comment" });
    sb.tick({ agyOut: "Error: something else broke", env });

    const warns = sb.messages().filter((t) => t.includes("old-model") && /AGENT_DISPATCH_MODELS/.test(t));
    expect(warns).toHaveLength(1);
  });

  it("accepts commas as well as spaces", () => {
    sb.tick({
      agyOut: "Error: boom",
      env: { AGENT_DISPATCH_MODELS: "a-one,b-two,c-three", AGY_UNKNOWN_MODELS: "a-one b-two" },
    });

    expect(sb.agyModels()).toEqual(["a-one", "b-two", "c-three"]);
  });

  it("every candidate unknown ends agent:failed with the model error in the message, after trying each once", () => {
    sb.tick({
      env: { AGENT_DISPATCH_MODELS: "old-a old-b", AGY_UNKNOWN_MODELS: "old-a old-b" },
    });

    expect(sb.agyModels()).toEqual(["old-a", "old-b"]);
    expect(sb.ghLog()).toMatch(/--add-label agent:failed/);
    expect(sb.messages().join("\n")).toMatch(/not recognized as a known model/);
  });

  it("the legacy single AGENT_DISPATCH_MODEL still works as a one-item list", () => {
    sb.tick({ agyOut: "Error: boom", env: { AGENT_DISPATCH_MODEL: "only-model" } });

    expect(sb.agyModels()).toEqual(["only-model"]);
  });

  it("the default list starts with the current executor model", () => {
    sb.tick({ agyOut: "Error: boom" });

    expect(sb.agyModels()[0]).toBe("gemini-3.6-flash-medium");
  });

  it("a working first model is the only one run", () => {
    sb.tick({ agyOut: "Error: boom", env: { AGENT_DISPATCH_MODELS: "good-model other-model" } });

    expect(sb.agyModels()).toEqual(["good-model"]);
  });
});
