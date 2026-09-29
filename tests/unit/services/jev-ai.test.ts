/**
 * Unit tests for Jev AI System 1 service (src/services/jev-ai.ts).
 */
import { describe, it, expect } from "vitest";
import {
  JevAIService,
  evaluateJevSystem1Route,
  preFilterJevRagContext,
  validateJevToolDispatch,
  JEV_RAG_MIN_SCORE,
  JEV_RAG_MAX_LENGTH,
} from "../../../src/services/jev-ai.js";

describe("JevAIService — System 1 Decision Gateway & Pre-Filter", () => {
  describe("System 1 Routing Evaluation", () => {
    it("handles deterministic status intent immediately", () => {
      const result = evaluateJevSystem1Route({ intent: "status" });
      expect(result.handled).toBe(true);
      expect(result.route).toBe("system_status");
      expect(result.decision).toBe("SYSTEM_1_STATUS_CHECK");
    });

    it("handles deterministic ping intent immediately", () => {
      const result = evaluateJevSystem1Route({ prompt: "ping" });
      expect(result.handled).toBe(true);
      expect(result.route).toBe("system_health");
      expect(result.decision).toBe("SYSTEM_1_HEALTH_PONG");
    });

    it("handles deterministic cancel intent immediately", () => {
      const result = evaluateJevSystem1Route({ intent: "cancel" });
      expect(result.handled).toBe(true);
      expect(result.route).toBe("system_cancel");
      expect(result.decision).toBe("SYSTEM_1_CANCEL_MISSION");
    });

    it("returns handled: false for complex or unmatched queries", () => {
      const result = evaluateJevSystem1Route({ intent: "Write a comprehensive marketing strategy for FounderOS" });
      expect(result.handled).toBe(false);
      expect(result.reason).toContain("fallback");
    });

    it("bypasses System 1 routing when service is disabled", () => {
      const disabledService = new JevAIService({ enabled: false });
      const result = disabledService.evaluateSystem1Routing({ intent: "status" });
      expect(result.handled).toBe(false);
      expect(result.reason).toContain("disabled");
    });
  });

  describe("RAG Context Pre-Filtering", () => {
    it("filters out low score items below JEV_RAG_MIN_SCORE", () => {
      const items = [
        { text: "High relevance context chunk", score: 0.85 },
        { text: "Low relevance noisy chunk", score: 0.05 },
      ];
      const res = preFilterJevRagContext(items);
      expect(res.filteredCount).toBe(1);
      expect(res.filtered[0]!.text).toBe("High relevance context chunk");
    });

    it("deduplicates identical text chunks", () => {
      const items = [
        { text: "Duplicate architectural record", score: 0.9 },
        { text: "Duplicate architectural record", score: 0.88 },
      ];
      const res = preFilterJevRagContext(items);
      expect(res.filteredCount).toBe(1);
    });

    it("trims content exceeding JEV_RAG_MAX_LENGTH", () => {
      const longText = "A".repeat(JEV_RAG_MAX_LENGTH + 500);
      const items = [{ text: longText, score: 0.9 }];
      const res = preFilterJevRagContext(items);
      expect(res.filtered[0]!.text).toContain("... [trimmed by Jev AI]");
      expect(res.trimmedBytes).toBe(500);
    });

    it("returns items untouched when disabled", () => {
      const disabledService = new JevAIService({ enabled: false });
      const items = [{ text: "Context text", score: 0.01 }];
      const res = disabledService.preFilterRagContext(items);
      expect(res.filteredCount).toBe(1);
      expect(res.trimmedBytes).toBe(0);
    });
  });

  describe("Tool Dispatch Validation", () => {
    it("validates well-formed tool execution arguments", () => {
      const res = validateJevToolDispatch("search_knowledge", { query: "FounderOS" });
      expect(res.valid).toBe(true);
    });

    it("rejects tool dispatch with invalid arguments", () => {
      const res = validateJevToolDispatch("search_knowledge", null as unknown as Record<string, unknown>);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("Tool arguments must be a plain object");
    });

    it("rejects prototype pollution attempts", () => {
      const badArgs = JSON.parse('{"__proto__": {"admin": true}}');
      const res = validateJevToolDispatch("vps_run", badArgs);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("Forbidden parameter in tool arguments");
    });

    it("allows execution when Jev AI is disabled", () => {
      const disabledService = new JevAIService({ enabled: false });
      const res = disabledService.validateToolDispatch("test_tool", {});
      expect(res.valid).toBe(true);
    });
  });
});
