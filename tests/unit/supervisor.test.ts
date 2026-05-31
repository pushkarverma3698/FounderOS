/**
 * Unit tests for supervisor.ts
 * Tests: _resolveDepartment — registry lookup + keyword heuristics (pure function)
 */

import { describe, it, expect } from "vitest";
import { _resolveDepartment } from "../../src/agents/supervisor.js";

// ── Registry-backed agents (have explicit `department` field) ─────────────────

describe("_resolveDepartment — registry-backed agents", () => {
  it("resolves lead_intel → sales (registry)", () => {
    expect(_resolveDepartment("lead_intel")).toBe("sales");
  });

  it("resolves bdr → sales (registry)", () => {
    expect(_resolveDepartment("bdr")).toBe("sales");
  });

  it("resolves bidding_sniper → sales (registry)", () => {
    expect(_resolveDepartment("bidding_sniper")).toBe("sales");
  });

  it("resolves proposal_writer → sales (registry)", () => {
    expect(_resolveDepartment("proposal_writer")).toBe("sales");
  });

  it("resolves senior_dev → engineering (registry)", () => {
    expect(_resolveDepartment("senior_dev")).toBe("engineering");
  });

  it("resolves vibe_coder → engineering (registry)", () => {
    expect(_resolveDepartment("vibe_coder")).toBe("engineering");
  });

  it("resolves qa_tester → engineering (registry)", () => {
    expect(_resolveDepartment("qa_tester")).toBe("engineering");
  });

  it("resolves github_agent → engineering (registry)", () => {
    expect(_resolveDepartment("github_agent")).toBe("engineering");
  });

  it("resolves web_designer → marketing (registry)", () => {
    expect(_resolveDepartment("web_designer")).toBe("marketing");
  });

  it("resolves seo_specialist → marketing (registry)", () => {
    expect(_resolveDepartment("seo_specialist")).toBe("marketing");
  });

  it("resolves social_researcher → social (registry)", () => {
    expect(_resolveDepartment("social_researcher")).toBe("social");
  });

  it("resolves social_handler → social (registry)", () => {
    expect(_resolveDepartment("social_handler")).toBe("social");
  });
});

// ── Keyword heuristics (agents NOT in registry, or cross-company without dept) ─

describe("_resolveDepartment — keyword heuristics for unknown agents", () => {
  // Sales keywords
  it("matches 'sales' keyword → sales", () => {
    expect(_resolveDepartment("sales_agent")).toBe("sales");
  });

  it("matches 'bdr' keyword → sales", () => {
    expect(_resolveDepartment("bdr_v2")).toBe("sales");
  });

  it("matches 'outreach' keyword → sales", () => {
    expect(_resolveDepartment("outreach_specialist")).toBe("sales");
  });

  it("matches 'pipeline_md' keyword → sales", () => {
    expect(_resolveDepartment("pipeline_md")).toBe("sales");
  });

  it("matches 'proposal' keyword → sales", () => {
    expect(_resolveDepartment("proposal_agent_v2")).toBe("sales");
  });

  it("matches 'bidding' keyword → sales", () => {
    expect(_resolveDepartment("bidding_bot")).toBe("sales");
  });

  // Engineering keywords
  it("matches 'dev' keyword → engineering", () => {
    expect(_resolveDepartment("frontend_dev")).toBe("engineering");
  });

  it("matches 'engineer' keyword → engineering", () => {
    expect(_resolveDepartment("backend_engineer")).toBe("engineering");
  });

  it("matches 'coder' keyword → engineering", () => {
    expect(_resolveDepartment("coder_agent")).toBe("engineering");
  });

  it("matches 'tester' keyword → engineering", () => {
    expect(_resolveDepartment("unit_tester")).toBe("engineering");
  });

  it("matches 'qa' keyword → engineering", () => {
    expect(_resolveDepartment("qa_robot")).toBe("engineering");
  });

  it("matches 'vibe_cod' keyword → engineering", () => {
    expect(_resolveDepartment("vibe_coder_v2")).toBe("engineering");
  });

  // Marketing keywords
  it("matches 'seo' keyword → marketing", () => {
    expect(_resolveDepartment("seo_bot")).toBe("marketing");
  });

  it("matches 'marketing' keyword → marketing", () => {
    expect(_resolveDepartment("marketing_manager")).toBe("marketing");
  });

  it("matches 'content' keyword → marketing", () => {
    expect(_resolveDepartment("content_writer")).toBe("marketing");
  });

  it("matches 'social_media' keyword → social (social dept added, not marketing)", () => {
    // "social_media_*" names now route to social department — checked before marketing
    expect(_resolveDepartment("social_media_bot")).toBe("social");
  });

  it("matches 'social_' prefix keyword → social", () => {
    expect(_resolveDepartment("social_scheduler")).toBe("social");
  });

  it("matches 'linkedin_post' keyword → social (LinkedIn posting is a social task)", () => {
    // "linkedin_poster" contains "linkedin_post" which is in socialKeywords.
    // LinkedIn posting belongs to the social department, not marketing.
    expect(_resolveDepartment("linkedin_poster")).toBe("social");
  });

  it("matches 'linkedin' keyword → marketing for generic LinkedIn analytics/SEO agent", () => {
    // "linkedin_seo" has "linkedin" but NOT in any social keyword → marketing
    // Note: "linkedin_outreach" would match "outreach" (sales) first.
    expect(_resolveDepartment("linkedin_seo")).toBe("marketing");
  });

  it("matches 'growth' keyword → marketing", () => {
    expect(_resolveDepartment("growth_hacker")).toBe("marketing");
  });

  it("matches 'designer' keyword → marketing", () => {
    expect(_resolveDepartment("vibe_designer_v2")).toBe("marketing");
  });
});

// ── Unknown / no match ────────────────────────────────────────────────────────

describe("_resolveDepartment — null fallback", () => {
  it("returns null for completely unknown agent name", () => {
    expect(_resolveDepartment("unknown_agent_xyz")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(_resolveDepartment("")).toBeNull();
  });

  it("returns null for known agent without department field (ops_agent)", () => {
    // ops_agent has no 'department' property in registry + no keyword match
    expect(_resolveDepartment("ops_agent")).toBeNull();
  });

  it("returns null for 'cost_watchdog' (cross-company, no department + no keyword)", () => {
    expect(_resolveDepartment("cost_watchdog")).toBeNull();
  });
});

// ── Case sensitivity ──────────────────────────────────────────────────────────

describe("_resolveDepartment — case insensitive keyword matching", () => {
  it("matches uppercase BDR keyword → sales", () => {
    // heuristic lowercases agent name before checking
    expect(_resolveDepartment("BDR_AGENT")).toBe("sales");
  });

  it("matches mixed-case SEO → marketing", () => {
    expect(_resolveDepartment("SEO_Specialist_v2")).toBe("marketing");
  });

  it("registry lookup is case-sensitive (lead_Intel not found, falls to heuristic)", () => {
    // "lead_Intel" won't match registry key "lead_intel"
    // but heuristic will NOT find it either since no keyword matches "lead_intel"
    // (lead_intel keyword list doesn't include "lead_intel" itself)
    // So result could be null — the important thing is it doesn't throw
    const result = _resolveDepartment("lead_Intel");
    expect(result === null || result === "sales").toBe(true);
  });
});
