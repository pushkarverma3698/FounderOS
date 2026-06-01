/**
 * RED tests for LLM-cache tenant isolation (architecture-review fix).
 * The llmCache key MUST include tenant_id so two tenants with an identical
 * prompt can never share a cached LLM response (data-isolation defect at SaaS scale).
 */

import { describe, it, expect } from "vitest";
import { KEYS } from "../../../src/infra/redis.js";

describe("KEYS.llmCache — tenant isolation", () => {
  it("namespaces the key by tenant_id then prompt hash", () => {
    expect(KEYS.llmCache("turicks", "abc123")).toBe("llm:turicks:abc123");
  });

  it("produces DIFFERENT keys for different tenants with the same prompt hash", () => {
    const a = KEYS.llmCache("turicks", "samehash");
    const b = KEYS.llmCache("acme", "samehash");
    expect(a).not.toBe(b);
    expect(a).toContain("turicks");
    expect(b).toContain("acme");
  });

  it("produces the SAME key for the same tenant + hash (cache hits still work intra-tenant)", () => {
    expect(KEYS.llmCache("turicks", "h")).toBe(KEYS.llmCache("turicks", "h"));
  });

  it("keeps the prompt hash in the key (does not collapse distinct prompts)", () => {
    expect(KEYS.llmCache("turicks", "hash-1")).not.toBe(KEYS.llmCache("turicks", "hash-2"));
  });
});

describe("KEYS.quota — tenant isolation (regression guard)", () => {
  it("namespaces the daily quota counter by tenant", () => {
    expect(KEYS.quota("turicks", "2026-06-01")).toBe("quota:turicks:2026-06-01");
  });

  it("produces different quota keys for different tenants on the same day", () => {
    expect(KEYS.quota("turicks", "2026-06-01")).not.toBe(KEYS.quota("acme", "2026-06-01"));
  });
});
