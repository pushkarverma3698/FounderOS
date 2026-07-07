import { describe, it, expect, vi } from "vitest";
import { wrapSupervisorModel } from "../../../src/agents/office.js";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// Mock a minimal BaseChatModel
function createMockModel(mockInvoke: Function) {
  const model = {
    _modelType: () => "base_chat_model",
    bindTools: vi.fn().mockImplementation(function (this: any) {
      return this;
    }),
    invoke: vi.fn().mockImplementation(mockInvoke),
  } as unknown as BaseChatModel;
  return model;
}

describe("Deterministic Supervisor Wrapper", () => {
  it("Option A: Routes to target department if not yet run", async () => {
    const mockInvoke = vi.fn();
    const model = createMockModel(mockInvoke);
    const wrapped = wrapSupervisorModel(model);

    const messages = [
      new SystemMessage("[ROUTING DIRECTIVE: A deterministic classifier routed this to the admin department. Transfer to admin first.]"),
      new HumanMessage("What is my current focus?"),
    ];

    const result = await wrapped.invoke(messages);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(AIMessage);
    expect(result.content).toContain("Routing to admin");
    expect(result.tool_calls?.[0]?.name).toBe("transfer_to_admin");
  });

  it("Option A: Returns department output verbatim if department has already run", async () => {
    const mockInvoke = vi.fn();
    const model = createMockModel(mockInvoke);
    const wrapped = wrapSupervisorModel(model);

    const messages = [
      new SystemMessage("[ROUTING DIRECTIVE: A deterministic classifier routed this to the admin department. Transfer to admin first.]"),
      new HumanMessage("What is my current focus?"),
      // Result from department
      new AIMessage({ content: "Your current focus is to launch FounderOS.", name: "admin" }),
      // Handoff back to supervisor
      new AIMessage({
        content: "Transferring back to supervisor",
        name: "admin",
        tool_calls: [{ name: "transfer_back_to_supervisor", args: {}, id: "call_back" }],
      }),
      new ToolMessage({
        content: "Successfully transferred back to supervisor",
        name: "transfer_back_to_supervisor",
        tool_call_id: "call_back",
      }),
    ];

    const result = await wrapped.invoke(messages);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(AIMessage);
    expect(result.content).toBe("Your current focus is to launch FounderOS.");
  });

  it("Option B: Executes multi-step task ledger step-by-step", async () => {
    const mockInvoke = vi.fn();
    const model = createMockModel(mockInvoke);
    const wrapped = wrapSupervisorModel(model);

    // Ledger has: research -> engineering -> synthesize
    const prompt = "research then github: compare AI frameworks and create an issue";
    const messages = [
      new HumanMessage(prompt),
    ];

    // First call: Should transfer to research
    const res1 = await wrapped.invoke(messages);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(res1.tool_calls?.[0]?.name).toBe("transfer_to_research");

    // Second call: With research completed, should transfer to engineering
    const messages2 = [
      new HumanMessage(prompt),
      new AIMessage({ content: "Research findings: LangGraph is best.", name: "research" }),
      new AIMessage({
        content: "Transferring back to supervisor",
        name: "research",
        tool_calls: [{ name: "transfer_back_to_supervisor", args: {}, id: "call_back_1" }],
      }),
      new ToolMessage({
        content: "Successfully transferred back to supervisor",
        name: "transfer_back_to_supervisor",
        tool_call_id: "call_back_1",
      }),
    ];
    const res2 = await wrapped.invoke(messages2);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(res2.tool_calls?.[0]?.name).toBe("transfer_to_engineering");
  });

  it("Option B: Delegates to original model for final synthesis when all steps done", async () => {
    const mockInvoke = vi.fn().mockResolvedValue(new AIMessage("Final synthesized reply."));
    const model = createMockModel(mockInvoke);
    const wrapped = wrapSupervisorModel(model);

    const prompt = "research then github: compare AI frameworks and create an issue";
    const messages = [
      new HumanMessage(prompt),
      // research done
      new AIMessage({ content: "Research findings: LangGraph is best.", name: "research" }),
      new AIMessage({
        content: "Transferring back to supervisor",
        name: "research",
        tool_calls: [{ name: "transfer_back_to_supervisor", args: {}, id: "call_back_1" }],
      }),
      new ToolMessage({
        content: "Successfully transferred back to supervisor",
        name: "transfer_back_to_supervisor",
        tool_call_id: "call_back_1",
      }),
      // engineering done
      new AIMessage({ content: "Issue #123 created successfully.", name: "engineering" }),
      new AIMessage({
        content: "Transferring back to supervisor",
        name: "engineering",
        tool_calls: [{ name: "transfer_back_to_supervisor", args: {}, id: "call_back_2" }],
      }),
      new ToolMessage({
        content: "Successfully transferred back to supervisor",
        name: "transfer_back_to_supervisor",
        tool_call_id: "call_back_2",
      }),
    ];

    const result = await wrapped.invoke(messages);

    expect(mockInvoke).toHaveBeenCalled();
    expect(result.content).toBe("Final synthesized reply.");
  });
});
