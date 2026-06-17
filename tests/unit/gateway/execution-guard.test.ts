/**
 * Unit tests for execution-claim guard (hallucinated shell / LinkedIn refusal).
 */

import { describe, it, expect } from "vitest";
import {
  detectUnbackedMemoryClaim,
  detectUnbackedShellClaim,
  detectLinkedInRefusalWithoutTool,
  hadToolCall,
  isInternalKnowledgeRequest,
  isShellRunRequest,
} from "../../../src/gateway/execution-guard.js";

function aiMsg(text: string, toolCalls?: { name: string }[]) {
  return {
    content: text,
    _getType: () => "ai",
    tool_calls: toolCalls,
  };
}

function toolMsg(name: string, content: string) {
  return { name, content, _getType: () => "tool" };
}

describe("isShellRunRequest", () => {
  it("detects terminal run prompts", () => {
    expect(isShellRunRequest('run this in terminal: echo "FounderOS E2E test"')).toBe(true);
  });
});

describe("hadToolCall", () => {
  it("finds run_shell in ai tool_calls", () => {
    expect(hadToolCall([aiMsg("", [{ name: "run_shell" }])], "run_shell")).toBe(true);
  });

  it("finds run_shell in tool messages", () => {
    expect(hadToolCall([toolMsg("run_shell", "stdout:\nok")], "run_shell")).toBe(true);
  });
});

describe("detectUnbackedShellClaim", () => {
  it("flags fake execution without run_shell", () => {
    const input = 'run this in terminal: echo "FounderOS E2E test"';
    const reply = 'The command executed successfully. stdout:\nFounderOS E2E test';
    expect(detectUnbackedShellClaim(input, [aiMsg(reply)], reply)).toBe(true);
  });

  it("flags supervisor deferral instead of run_shell", () => {
    const input = 'run this in terminal: echo "FounderOS E2E test"';
    const reply =
      "I can't execute commands directly in the terminal. You can run echo in your terminal yourself.";
    expect(detectUnbackedShellClaim(input, [aiMsg(reply)], reply)).toBe(true);
  });

  it("passes when run_shell was called", () => {
    const input = 'run this in terminal: echo "test"';
    const msgs = [aiMsg("", [{ name: "run_shell" }]), toolMsg("run_shell", "stdout:\ntest")];
    expect(detectUnbackedShellClaim(input, msgs, "stdout:\ntest")).toBe(false);
  });
});

describe("detectLinkedInRefusalWithoutTool", () => {
  it("flags prose refusal instead of linkedin_post", () => {
    const input = "linkedin: our game-changing innovative solution creates synergy";
    const reply =
      "I cannot post content with banned phrases like game-changing and synergy on LinkedIn.";
    expect(detectLinkedInRefusalWithoutTool(input, [aiMsg(reply)], reply)).toBe(true);
  });

  it("passes when linkedin_post was called", () => {
    const input = "linkedin: game-changing synergy post";
    const msgs = [aiMsg("", [{ name: "linkedin_post" }])];
    expect(detectLinkedInRefusalWithoutTool(input, msgs, "draft")).toBe(false);
  });
});

describe("isInternalKnowledgeRequest", () => {
  it("detects questions about our companies", () => {
    expect(isInternalKnowledgeRequest("What does Turicks do?")).toBe(true);
    expect(isInternalKnowledgeRequest("tell me about Naggar Retreat")).toBe(true);
  });

  it("detects questions about our internal state / decisions", () => {
    expect(isInternalKnowledgeRequest("what's our ICP?")).toBe(true);
    expect(isInternalKnowledgeRequest("what did we decide about pricing?")).toBe(true);
    expect(isInternalKnowledgeRequest("do you remember what we agreed on the roadmap?")).toBe(true);
  });

  it("ignores generic / arithmetic / greeting prompts", () => {
    expect(isInternalKnowledgeRequest("what is 2+2?")).toBe(false);
    expect(isInternalKnowledgeRequest("hi there")).toBe(false);
    expect(isInternalKnowledgeRequest("write a poem about the sea")).toBe(false);
  });

  it("ignores explicit web/research prompts even if a company is named", () => {
    expect(isInternalKnowledgeRequest("research Turicks competitors online")).toBe(false);
    expect(isInternalKnowledgeRequest("find the latest news about Naggar")).toBe(false);
  });
});

describe("detectUnbackedMemoryClaim", () => {
  const MEMORY_TOOLS = ["read_context", "search_memory", "search_knowledge", "search_turicks_brain"];

  it("flags an internal-knowledge answer produced without any memory tool", () => {
    const input = "What does Turicks do?";
    const reply =
      "Turicks is an AI agency that builds custom automation and cinematic web experiences for startups.";
    expect(detectUnbackedMemoryClaim(input, [aiMsg(reply)], reply)).toBe(true);
  });

  it("flags asking the founder back without first checking memory (SELF-QUERY rule)", () => {
    const input = "what did we decide about pricing?";
    const reply = "Could you remind me what your pricing model is?";
    expect(detectUnbackedMemoryClaim(input, [aiMsg(reply)], reply)).toBe(true);
  });

  it.each(MEMORY_TOOLS)("passes when %s was called", (tool) => {
    const input = "what's our ICP?";
    const msgs = [aiMsg("", [{ name: tool }]), toolMsg(tool, "ICP: seed-stage founders")];
    expect(detectUnbackedMemoryClaim(input, msgs, "Your ICP is seed-stage founders.")).toBe(false);
  });

  it("ignores non-internal questions entirely", () => {
    const input = "what is 2+2?";
    expect(detectUnbackedMemoryClaim(input, [aiMsg("4")], "4")).toBe(false);
  });

  it("ignores web/research prompts (those legitimately skip memory tools)", () => {
    const input = "research Turicks competitors online";
    const reply = "Top competitors include several boutique AI agencies.";
    expect(detectUnbackedMemoryClaim(input, [aiMsg(reply)], reply)).toBe(false);
  });
});
