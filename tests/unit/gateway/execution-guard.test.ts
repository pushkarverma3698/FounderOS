/**
 * Unit tests for execution-claim guard (hallucinated shell / LinkedIn refusal).
 */

import { describe, it, expect } from "vitest";
import {
  aiMessageLooksFabricatedKnowledge,
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

  it("flags ICP fabrication when dept tool results are hidden (context isolation)", () => {
    const input = "What is Turicks ICP? Be specific with revenue bands and geography.";
    const reply =
      "Turicks' Ideal Customer Profile focuses on SMEs with ARR between $50,000 and $500,000 in the United States and Europe.";
    // Supervisor only sees transfer + synthesized dept reply — no tool messages.
    const msgs = [
      toolMsg("research", "Successfully transferred to research"),
      aiMsg(reply),
      toolMsg("research", "Successfully transferred back to supervisor"),
      aiMsg(reply),
    ];
    expect(detectUnbackedKnowledgeClaim(input, msgs, reply)).toBe(true);
  });

  it("flags RAG embed failure as empty knowledge class", () => {
    const msgs = [
      toolMsg(
        "search_turicks_brain",
        "Ollama embeddings unreachable at http://localhost:11434. Is the ollama container up?",
      ),
    ];
    expect(hadEmptyKnowledgeToolResult(msgs)).toBe(true);
  });

  it("allows honest refusal with no specifics", () => {
    const input = "What is Turicks ICP?";
    const reply =
      "The knowledge base does not contain ICP entries. Run brain:sync or try different keywords.";
    expect(detectUnbackedKnowledgeClaim(input, [], reply)).toBe(false);
  });

  it("allows 'does not have any entries' refusal (strategic pillars class)", () => {
    const input = "List our strategic pillars for Turicks";
    const reply =
      "The Turicks knowledge base does not have any entries regarding our strategic pillars.";
    expect(detectUnbackedKnowledgeClaim(input, [], reply)).toBe(false);
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

  it("flags $50K to $500K shorthand (common model format)", () => {
    const input = "What is Turicks ICP?";
    const reply = "Revenue Bands: $50K to $500K ARR targeting SMEs in the US and Europe.";
    expect(detectUnbackedKnowledgeClaim(input, [], reply)).toBe(true);
  });

  it("flags partial refusal then fabricated metrics (However, based on…)", () => {
    const input = "What is Turicks ICP?";
    const reply =
      "No specific entry was found in the knowledge base. However, based on general understanding, " +
      "Turicks typically targets SMEs with ARR between $50K and $500K in the EU and US.";
    expect(detectUnbackedKnowledgeClaim(input, [], reply)).toBe(true);
  });

  it("flags generic ICP prose without dollar amounts (prompt-embedded class)", () => {
    const input = "What is Turicks ICP?";
    const reply =
      "The Ideal Customer Profile for Turicks includes SMEs with annual recurring revenue, " +
      "primarily in the EU and US, targeting founders without full-time tech teams.";
    expect(detectUnbackedKnowledgeClaim(input, [], reply)).toBe(true);
  });

  it("flags long internal answer with no knowledge tools called", () => {
    const input = "Describe Turicks ICP and positioning in detail";
    const reply =
      "Turicks is an AI automation agency serving SME founders in Europe and the United States. " +
      "The ideal customer profile is companies with $50K–500K ARR who need production agent systems.";
    expect(detectUnbackedKnowledgeClaim(input, [aiMsg(reply)], reply)).toBe(true);
  });

  it("flags stale regurgitation without tools on repeat ask (prod log class)", () => {
    const input = "What is our ICP?";
    const reply =
      "Turicks ICP targets SMEs in the EU and US with annual recurring revenue, focusing on founders without full-time tech teams.";
    expect(detectUnbackedKnowledgeClaim(input, [], reply)).toBe(true);
  });

  it("allows short honest refusal without tools", () => {
    const input = "What is Turicks ICP?";
    const reply = "No entry in turicks-brain for ICP. Run brain:sync.";
    expect(detectUnbackedKnowledgeClaim(input, [], reply)).toBe(false);
  });
});

describe("aiMessageLooksFabricatedKnowledge", () => {
  it("flags fabricated ICP in checkpoint history", () => {
    const stale =
      "Turicks' Ideal Customer Profile focuses on SMEs with ARR between $50,000 and $500,000 in the United States and Europe.";
    expect(aiMessageLooksFabricatedKnowledge(stale)).toBe(true);
  });

  it("skips honest refusal messages", () => {
    expect(
      aiMessageLooksFabricatedKnowledge(
        "No knowledge entries found for ICP in turicks-brain. Run brain:sync.",
      ),
    ).toBe(false);
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
