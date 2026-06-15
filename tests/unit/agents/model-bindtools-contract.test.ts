/**
 * Regression: FounderChatModel.bindTools must honour the LangChain RunnableBinding
 * contract that @langchain/langgraph-supervisor + createReactAgent depend on.
 *
 * The production crash: our old bindTools mutated `this.primaryModel` into a
 * RunnableBinding (which has no `bindTools`) and returned `this`. The supervisor
 * pre-binds, reads `.kwargs.tools`, then wraps the model in `withAgentName(...)`.
 * With no `.kwargs.tools` populated, the wrapper reached createReactAgent without a
 * `bindTools` method → "llm [object Object] must define bindTools method." on EVERY
 * office invoke (supervisor + all departments).
 *
 * These tests pin the invariants that prevent that class of bug, with no network.
 */

import { describe, it, expect, afterEach } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getModel } from "../../../src/agents/model.js";

const noopTool = tool(async () => "ok", {
  name: "noop",
  description: "no-op tool for binding tests",
  schema: z.object({ x: z.string().optional() }),
});

describe("FounderChatModel.bindTools — supervisor binding contract", () => {
  afterEach(() => {
    delete process.env["AGENT_MODEL"];
    delete process.env["OPENROUTER_API_KEY"];
  });

  it("returns a RunnableBinding whose .kwargs.tools is populated (the supervisor hack reads this)", () => {
    const m = getModel();
    const bound = m.bindTools([noopTool]) as unknown as { kwargs?: { tools?: unknown[] } };
    expect(bound.kwargs).toBeDefined();
    expect(Array.isArray(bound.kwargs?.tools)).toBe(true);
    expect((bound.kwargs?.tools ?? []).length).toBeGreaterThan(0);
  });

  it("does NOT mutate the shared instance (primaryModel stays an unbound chat model with bindTools)", () => {
    const m = getModel();
    const primaryBefore = (m as unknown as { primaryModel: unknown }).primaryModel;
    m.bindTools([noopTool]);
    const primaryAfter = (m as unknown as { primaryModel: { bindTools?: unknown } }).primaryModel;
    // same reference, still unbound, still has bindTools (was previously replaced by a RunnableBinding)
    expect(primaryAfter).toBe(primaryBefore);
    expect(typeof primaryAfter.bindTools).toBe("function");
  });

  it("the wrapper itself remains re-bindable (createReactAgent re-binds after the supervisor pre-binds)", () => {
    const m = getModel();
    // FounderChatModel must keep its own bindTools — _shouldBindTools / getModelRunnable call it again
    expect("bindTools" in m).toBe(true);
    expect(typeof m.bindTools).toBe("function");
    // Re-binding the same shared instance must not throw and must stay contract-compliant
    const a = m.bindTools([noopTool]) as unknown as { kwargs?: { tools?: unknown[] } };
    const b = m.bindTools([noopTool]) as unknown as { kwargs?: { tools?: unknown[] } };
    expect(Array.isArray(a.kwargs?.tools)).toBe(true);
    expect(Array.isArray(b.kwargs?.tools)).toBe(true);
  });

  it("reports _modelType base_chat_model so isChatModelWithBindTools() recognises it", () => {
    const m = getModel() as unknown as { _modelType?: () => string };
    expect(typeof m._modelType).toBe("function");
    expect(m._modelType?.()).toBe("base_chat_model");
  });
});
