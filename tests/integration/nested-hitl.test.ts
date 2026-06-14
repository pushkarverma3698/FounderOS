/**
 * FounderOS — Nested HITL integration test (Phase 5 hierarchy spike)
 * ==================================================================
 * Proves the load-bearing risk of hierarchy: an interrupt() raised THREE levels
 * deep (parent supervisor → revenue sub-supervisor → sales/marketing dept →
 * HITL-gated tool) still SURFACES via getState().tasks and RESUMES correctly —
 * the same path the gateway run-loop (office-run.ts) depends on.
 *
 *   parent → revenue → marketing → linkedin_post → interrupt()
 *   reject  → the real linkedin tool is NEVER called
 *   approve → the real linkedin tool runs exactly once
 *   parent → research → search_web → NO interrupt (control case)
 *
 * Live Gemini (cheap) + MemorySaver; external sends mocked. Skips without a real
 * Google key — exactly like office-hitl.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

// ── Mock external side-effects BEFORE importing the graph ─────────────────────

const linkedinExecute = vi.fn(async () => ({
  success: true,
  data: { post_id: "li_test_123" },
}));
vi.mock("../../src/tools/linkedin.js", () => ({
  linkedinPostTool: { name: "linkedin_post", description: "mock", execute: linkedinExecute },
}));

const searchExecute = vi.fn(async () => ({
  success: true,
  data: [{ title: "Stripe", url: "https://stripe.com", snippet: "Payments infrastructure." }],
}));
vi.mock("../../src/tools/web-search.js", () => ({
  webSearchTool: { name: "search_web", description: "mock", execute: searchExecute },
}));

vi.mock("../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, isSuppressed: vi.fn(async () => false) };
});

const { buildNestedOffice } = await import("../../src/agents/revenue-domain.js");
const { getPendingApproval } = await import("../../src/agents/office.js");

// ── Guard: only run with a real Google key ────────────────────────────────────

const _gKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? "";
const hasRealKey = _gKey.length > 20 && !_gKey.includes("test");
const d = hasRealKey ? describe : describe.skip;

d("Nested HITL (parent → revenue → dept), live model, mocked sends", () => {
  beforeEach(() => {
    linkedinExecute.mockClear();
    searchExecute.mockClear();
  });

  it("LinkedIn post 3 levels deep → interrupt surfaces, REJECT → not posted", { timeout: 90_000 }, async () => {
    const office = buildNestedOffice(new MemorySaver());
    const config = { configurable: { thread_id: "nested-reject" } };

    await office.invoke(
      {
        messages: [
          new HumanMessage(
            "Post this on LinkedIn: '3 founders asked me about AI agents today. Here is what I told them: start with one painful workflow, automate it end to end, measure the hours saved, then expand. That is how you get real ROI from AI without boiling the ocean or hiring a data team. Small, focused, measured. That beats a big bang every time for a lean team that needs results this quarter, not next year.'",
          ),
        ],
      },
      config,
    );

    const approval = await getPendingApproval(office, config);
    expect(approval, "expected a nested approval interrupt").toBeTruthy();
    expect(approval!.action).toBe("linkedin_post");
    expect(linkedinExecute).not.toHaveBeenCalled();

    await office.invoke(new Command({ resume: "rejected" }), config);
    expect(linkedinExecute).not.toHaveBeenCalled();
  });

  it("LinkedIn post 3 levels deep → APPROVE → posted exactly once", { timeout: 90_000 }, async () => {
    const office = buildNestedOffice(new MemorySaver());
    const config = { configurable: { thread_id: "nested-approve" } };

    await office.invoke(
      {
        messages: [
          new HumanMessage(
            "Post this on LinkedIn: '3 founders asked me about AI agents today. Here is what I told them: start with one painful workflow, automate it end to end, measure the hours saved, then expand. That is how you get real ROI from AI without boiling the ocean or hiring a data team. Small, focused, measured. That beats a big bang every time for a lean team that needs results this quarter, not next year.'",
          ),
        ],
      },
      config,
    );

    const approval = await getPendingApproval(office, config);
    expect(approval, "expected a nested approval interrupt").toBeTruthy();
    expect(linkedinExecute).not.toHaveBeenCalled();

    await office.invoke(new Command({ resume: "approved" }), config);
    expect(linkedinExecute).toHaveBeenCalledOnce();
  });

  it("research question → routes parent → research, NO interrupt (control)", { timeout: 90_000 }, async () => {
    const office = buildNestedOffice(new MemorySaver());
    const config = { configurable: { thread_id: "nested-research" } };

    await office.invoke(
      { messages: [new HumanMessage("Search the web and tell me what Stripe does.")] },
      config,
    );

    const approval = await getPendingApproval(office, config);
    expect(approval, "research should NOT need approval").toBeNull();
    expect(searchExecute).toHaveBeenCalled();
  });
});
