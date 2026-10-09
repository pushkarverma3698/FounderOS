/**
 * Unit tests — planner prompt routing rules (pure string build).
 * ================================================================
 * 2026-07-11 incidents 1022a8a5/97c82adf: "what schedulers run in FounderOS"
 * planned personal.list_dir over ~/Projects instead of engineering github_read
 * on the founderos repo. The planner prompt is THE router in v3 — the
 * self-knowledge rule below is the routing contract for those questions.
 */

import { describe, it, expect } from "vitest";
import { buildPlannerPrompt, type WorkerCatalogEntry } from "../../../src/kernel/planner.js";
import { CONTEXT_STALE_MARKER } from "../../../src/db/context-meta.js";
import { renderFounderContext } from "../../../src/tools/context-render.js";

const catalog: WorkerCatalogEntry[] = [
  { id: "engineering", description: "code and repo work", toolNames: ["github_read"], gatedToolNames: [] },
  { id: "personal", description: "founder files", toolNames: ["list_dir", "read_file"], gatedToolNames: [] },
];

describe("buildPlannerPrompt — tool budget is code's job", () => {
  it("does not ask the planner to choose a tool-call count", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).not.toContain("max_tool_calls");
    expect(prompt).toContain('"constraints":{"hitl_required":<bool>}');
  });
});

describe("buildPlannerPrompt — FounderOS self-knowledge routing", () => {
  it("routes questions about FounderOS itself to engineering github_read, never personal file tools", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toContain("Questions about FounderOS itself");
    expect(prompt).toContain("github_read");
    expect(prompt).toContain("/opt/founderos");
    expect(prompt).toMatch(/never.*(list_dir|read_file|personal file tools)/i);
  });

  it("keeps the founder-context rule (read_context/search_memory) intact", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toContain("read_context");
    expect(prompt).toContain("search_memory");
  });

  // Ported from the deleted SUPERVISOR_PROMPT guard (2026-06-04: "Send the
  // text.txt file on my desktop" → the router answered "Okay", planned nothing
  // and called no tool). v3 has no supervisor; the planner's direct-reply path
  // is where that failure would recur, so the clause forbidding it is the guard.
  it("forbids answering a founder question directly instead of planning a step", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toMatch(/are NOT direct replies/i);
    expect(prompt).toMatch(/never answer from priors/i);
  });
});

describe("buildPlannerPrompt — draft is not send (live 89188cd5)", () => {
  // 2026-07-11 21:45: founder said "just draft a LinkedIn post" and got a
  // publish-approval card — the planner routed a DRAFT request into the gated
  // linkedin_post tool. Drafting must produce content for review, not actions.
  it("tells the planner that draft/write/prepare requests never call posting or sending tools", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toMatch(/draft.*(is not|≠|never).*(send|post|publish)/is);
    expect(prompt).toContain('"draft"');
  });
});

/**
 * 2026-09-21 07:23, production. The founder sent:
 *
 *   "Create a GitHub issue in FounderOS to add a visible test comment to the
 *    bottom of the README.md file, and explicitly label it agent:ready so the
 *    VPS dispatcher picks it up"
 *
 * The planner produced the step "Record the founder's rule and preference into
 * business context", called update_context, rewrote his persistent business
 * context, and replied that a PDF preference had been saved. No issue was filed.
 * Sixteen minutes later he wrote the dispatch brief by hand.
 *
 * Two failures met there. The stale-history one is fixed by the session bound in
 * state.ts (see history-session-bound.test.ts). This is the other half: filing a
 * GitHub issue was never named as a route, and nothing said that a memory tool is
 * not a substitute for performing the task.
 */
describe("buildPlannerPrompt — issue filing is a dispatch, not a memory write", () => {
  it("routes 'create/file a GitHub issue' to the dispatch tool", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toMatch(/creat\w*|fil\w*/i);
    expect(prompt).toMatch(/GitHub issue/i);
    expect(prompt).toContain("dispatch_antigravity_task");
    expect(prompt).toMatch(/agent:ready/);
  });

  it("forbids a memory/context write standing in for a task the founder asked for", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toMatch(/update_context/);
    expect(prompt).toMatch(/never.*(substitute|instead of).*(task|action|request)/i);
  });
});

/**
 * 2026-09-29, production: "what is my current focus?" was answered with June's
 * "Phase D-Bis: 3 proof showcases…" as if it were current. read_context now dates
 * every value and marks a stale or undated one with a mark produced by CODE
 * (src/tools/context-render.ts). This rule is what the model does with that mark;
 * it names the same constant the renderer prints, so the two cannot drift apart.
 */
describe("buildPlannerPrompt — a stale context line is dated or asked about, never current", () => {
  it("tells the planner what to do with a line carrying the stale mark", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toContain(`A context line marked ${CONTEXT_STALE_MARKER} must be stated with its date, or asked about.`);
    expect(prompt).toContain("Never present it as current.");
  });

  it("names the mark the renderer really prints on a value that has no date", () => {
    const rendered = renderFounderContext({ current_focus: "Phase D-Bis" }, new Date("2026-09-29T09:00:00Z"), {
      timeZone: "Asia/Kolkata",
    });
    expect(rendered).toContain(CONTEXT_STALE_MARKER);
    expect(buildPlannerPrompt(catalog)).toContain(`marked ${CONTEXT_STALE_MARKER}`);
  });

  it("keeps the rule next to the founder-context rule it qualifies", () => {
    const lines = buildPlannerPrompt(catalog).split("\n");
    const contextRule = lines.findIndex((l) => l.includes("read_context, search_memory"));
    const staleRule = lines.findIndex((l) => l.includes(`marked ${CONTEXT_STALE_MARKER}`));
    expect(contextRule).toBeGreaterThan(-1);
    expect(staleRule).toBe(contextRule + 1);
  });
});

describe("buildPlannerPrompt — news and outside-world questions go to research", () => {
  // 2026-10-09 live QA: "what is the latest news on Anthropic Claude this week?" was planned as
  // "Check the status of the Antigravity task for Oplify issue 115": the answer was a coding-pipeline status.
  it("sends news, current events and public facts to research search_web, even when they name Claude or Anthropic", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toMatch(/news|current events/i);
    expect(prompt).toContain("search_web");
    expect(prompt).toMatch(/Anthropic/);
  });

  it("keeps the coding-pipeline status rule for questions that name an issue, PR, repo or Antigravity", () => {
    const prompt = buildPlannerPrompt(catalog);
    expect(prompt).toMatch(/only a question that names .*(issue|PR|repo|Antigravity)/i);
  });
});
