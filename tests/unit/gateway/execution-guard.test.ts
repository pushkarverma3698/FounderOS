/**
 * Unit tests for execution-claim guard (hallucinated shell / LinkedIn refusal).
 */

import { describe, it, expect } from "vitest";
import {
  detectUnbackedKnowledgeClaim,
  detectUnbackedShellClaim,
  detectLinkedInRefusalWithoutTool,
  hadEmptyKnowledgeToolResult,
  hadToolCall,
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

describe("detectUnbackedKnowledgeClaim", () => {
  it("flags confident reply after empty search_knowledge result (prod ICP class)", () => {
    const input = "What is Turicks ICP?";
    const reply =
      "Turicks targets B2B SaaS founders in seed stage across EU and US with $50K–500K ARR, focusing on SMEs without full-time tech teams.";
    const msgs = [
      toolMsg(
        "search_knowledge",
        'No knowledge entries found for "ICP" (type: strategic_pillar). Do NOT fabricate an answer.',
      ),
      aiMsg(reply),
    ];
    expect(hadEmptyKnowledgeToolResult(msgs)).toBe(true);
    expect(detectUnbackedKnowledgeClaim(input, msgs, reply)).toBe(true);
  });

  it("does not flag honest refusal after empty search", () => {
    const input = "What is Turicks ICP?";
    const reply = "No knowledge entries found for ICP in turicks-brain. Run brain:sync.";
    const msgs = [
      toolMsg("search_knowledge", 'No knowledge entries found for "ICP". Do NOT fabricate.'),
      aiMsg(reply),
    ];
    expect(detectUnbackedKnowledgeClaim(input, msgs, reply)).toBe(false);
  });

  it("flags long internal answer with no knowledge tools called", () => {
    const input = "Describe Turicks ICP and positioning in detail";
    const reply =
      "Turicks is an AI automation agency serving SME founders in Europe and the United States. " +
      "The ideal customer profile is companies with $50K–500K ARR who need production agent systems.";
    expect(detectUnbackedKnowledgeClaim(input, [aiMsg(reply)], reply)).toBe(true);
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
