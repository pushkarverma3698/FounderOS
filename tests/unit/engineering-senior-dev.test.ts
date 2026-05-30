/**
 * TDD — senior_dev node: real LLM code generation (not hardcoded stubs).
 *
 * Problem: seniorDevNode currently returns a hardcoded comment scaffold —
 *   `// Phase 3: two-phase LLM execution...`
 *
 * Fix: seniorDevNode must call callCascade("code", ...) using the SENIOR_DEV
 * system prompt, then put the LLM response in code_draft.
 *
 * These unit tests use vi.mock to isolate seniorDevNode from DB / Redis / LLM.
 * The mocked callCascade returns a fake TypeScript snippet so we can verify:
 *   1. callCascade IS called (not short-circuited by the stub)
 *   2. code_draft contains the LLM response, not a hardcoded comment string
 *   3. The SENIOR_DEV system prompt exists and mentions TypeScript
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock infra dependencies ────────────────────────────────────────────────────
// We need to mock callCascade so seniorDevNode doesn't hit real LLMs or Redis.
vi.mock("../../src/infra/llm.js", () => ({
  callCascade: vi.fn().mockResolvedValue({
    text: 'import { z } from "zod";\n\nexport const DocumentSchema = z.object({\n  id: z.string(),\n  type: z.enum(["passport", "utility_bill"]),\n  extractedData: z.record(z.string()),\n});\n\nexport type Document = z.infer<typeof DocumentSchema>;',
    model: "qwen3-coder:free",
    usage: { input_tokens: 100, output_tokens: 200 },
  }),
  checkBudget: vi.fn().mockResolvedValue(undefined),
  safeParseJson: vi.fn().mockReturnValue(null), // code nodes don't return JSON
}));

vi.mock("../../src/db/queries.js", () => ({
  hasBeenAudited: vi.fn().mockResolvedValue(false),
  writeAuditEntry: vi.fn().mockResolvedValue(undefined),
  writeTaskOutcome: vi.fn().mockResolvedValue(undefined),
  getRecentOutcomes: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/gateway/hitl.js", () => ({
  requestHITL: vi.fn().mockResolvedValue({
    status: "approved",
    interrupt_id: "test-interrupt-id",
    requested_at: new Date().toISOString(),
  }),
}));

vi.mock("../../src/infra/logger.js", () => ({
  childLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Imports after mocks ────────────────────────────────────────────────────────
import { callCascade } from "../../src/infra/llm.js";
import { getSystem } from "../../src/core/prompts.js";

// ── Helpers ────────────────────────────────────────────────────────────────────
function makeEngState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    trace_id: "test-trace-id",
    tenant_id: "turicks",
    task: "Build a TypeScript microservice for document KYC processing with LangGraph HITL",
    spec: "Build KYC document processing microservice",
    eng_engineer_plan: {
      summary: "KYC automation microservice with document extraction + risk scoring",
      risks: ["LLM latency for extraction", "GDPR compliance"],
      steps: [
        { step: 1, action: "Define TypeScript interfaces for document types", tier: "code", tool: null, hitl_required: false },
        { step: 2, action: "Implement document extraction agent", tier: "code", tool: "web_search", hitl_required: false },
        { step: 3, action: "Push to GitHub repo", tier: "code", tool: "github", hitl_required: true },
      ],
      estimated_hours: 8,
      first_deliverable: "TypeScript interface definitions + agent scaffold",
    },
    code_draft: null,
    test_results: null,
    hitl: null,
    final: null,
    errors: [],
    auto_approve: false,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("senior_dev node", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. callCascade IS invoked ────────────────────────────────────────────────
  it("calls callCascade (code tier) to generate actual code — not a hardcoded stub", async () => {
    // We need to dynamically import the engineering subgraph to run the node.
    // But the graph includes DB calls in finalize, which we can't easily isolate.
    // Instead, test the prompt coverage + callCascade invocation via the subgraph.
    //
    // The key invariant: callCascade must be called at least once for code tier
    // when seniorDevNode executes with a valid eng_engineer_plan.

    const { engineeringSubgraph } = await import("../../src/agents/pods/engineering.js");

    const state = makeEngState();
    await engineeringSubgraph.invoke(state);

    // callCascade must have been called — it was NOT called in the stub version
    expect(callCascade).toHaveBeenCalled();

    // Must be called with "code" tier (not "md" — that's for eng_engineer planning)
    const calls = vi.mocked(callCascade).mock.calls;
    const codeTierCalls = calls.filter((call) => call[0] === "code");
    expect(codeTierCalls.length).toBeGreaterThan(0);
  });

  // ── 2. code_draft contains LLM response ─────────────────────────────────────
  it("puts LLM response text into code_draft — not hardcoded Phase 3 comments", async () => {
    const { engineeringSubgraph } = await import("../../src/agents/pods/engineering.js");

    const state = makeEngState();
    const result = await engineeringSubgraph.invoke(state);

    expect(result.code_draft).toBeTruthy();

    // Must NOT be the old stub comment
    expect(result.code_draft as string).not.toContain("Phase 3: two-phase LLM execution");
    expect(result.code_draft as string).not.toContain("// Engineering pod stub");

    // Must contain the mocked LLM response (real TypeScript syntax)
    expect(result.code_draft as string).toContain("import");
  });

  // ── 3. SENIOR_DEV system prompt exists ──────────────────────────────────────
  it("SENIOR_DEV system prompt exists in prompts.ts", () => {
    // getSystem throws if key doesn't exist — so this test is self-documenting
    expect(() => getSystem("SENIOR_DEV")).not.toThrow();
    const prompt = getSystem("SENIOR_DEV");
    expect(prompt).toBeTruthy();
    expect(prompt.length).toBeGreaterThan(100);
  });

  // ── 4. SENIOR_DEV prompt mandates TypeScript ─────────────────────────────────
  it("SENIOR_DEV prompt mandates real TypeScript code output — not stubs or comments", () => {
    const prompt = getSystem("SENIOR_DEV");
    // Must mention TypeScript (this is a TypeScript shop)
    expect(prompt.toLowerCase()).toContain("typescript");
    // Must say something about producing actual code
    expect(prompt.toLowerCase()).toMatch(/no.*stub|no.*placeholder|real.*code|actual.*code|implement/);
  });
});
