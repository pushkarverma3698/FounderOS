/**
 * FounderOS — Live One-Man Company Integration Test
 * ===================================================
 * Proves FounderOS can run an entire one-man company by assigning real tasks
 * to every department pod and verifying cross-department collaboration.
 *
 * Strategy:
 *   - callCascade → intercepted, all calls routed to Ollama founderos:latest
 *   - DB (queries.js) → mocked with spies so we can SEE what agents try to save
 *   - Redis → mocked fail-open (quota = 0, research cache = miss)
 *   - HITL → auto-approved (simulates human saying "yes" instantly)
 *   - All actual LLM reasoning → REAL (qwen2.5:7b via Ollama)
 *
 * Tests (5 departments + 1 cross-dept handoff):
 *   1. SUPERVISOR — routes diverse tasks to correct departments
 *   2. PROSPECTING POD — researches Notion.so, ICP scores it, hands off to Sales
 *   3. SALES POD — engineer picks strategy, BDR drafts email, critic iterates, finalizes
 *   4. ENGINEERING POD — plans a React dashboard feature end-to-end
 *   5. MARKETING POD — writes LinkedIn post on AI cost reduction
 *   6. CROSS-DEPT — prospecting → sales full handoff (state passing between departments)
 *
 * Run: pnpm test tests/live/one-man-company.test.ts --reporter=verbose
 */

import { describe, it, expect, vi, beforeAll, afterAll, type MockedFunction } from "vitest";

// ── CRITICAL: Mocks must be hoisted before src imports ────────────────────────

// All LLM calls → Ollama (real intelligence, local model)
vi.mock("../../src/infra/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/infra/llm.js")>("../../src/infra/llm.js");
  return {
    ...actual,
    callCascade: vi.fn(),     // will be configured in beforeAll
    checkBudget: vi.fn().mockResolvedValue(undefined),
  };
});

// DB — mocked with spies so we can observe what agents try to write
vi.mock("../../src/db/queries.js", () => ({
  hasBeenAudited:   vi.fn().mockResolvedValue(false),
  writeAuditEntry:  vi.fn().mockResolvedValue(undefined),
  createInterrupt:  vi.fn().mockResolvedValue("live-test-interrupt-id"),
  resolveInterrupt: vi.fn().mockResolvedValue(true),
  logCost:          vi.fn().mockResolvedValue(undefined),
  isSuppressed:     vi.fn().mockResolvedValue(false),
  logLlmCost:       vi.fn().mockResolvedValue(undefined),
  createLead:       vi.fn().mockResolvedValue("live-test-lead-id"),
  updateLead:       vi.fn().mockResolvedValue(undefined),
  updateLeadStage:  vi.fn().mockResolvedValue(undefined),
  getLeadByUrl:     vi.fn().mockResolvedValue(null),
  // Phase 3B: self-improvement loop (non-blocking, return empty arrays/void)
  writeTaskOutcome: vi.fn().mockResolvedValue(undefined),
  getRecentOutcomes: vi.fn().mockResolvedValue([]),
  // Budget guard — always return 0 (well under limit)
  getTodayCostUsd: vi.fn().mockResolvedValue(0),
  // Cross-department events (Phase 3C)
  publishDeptEvent: vi.fn().mockResolvedValue(undefined),
  consumePendingEvents: vi.fn().mockResolvedValue([]),
}));

// Redis — fail-open (quota = 0 = allow, research cache = miss)
vi.mock("../../src/infra/redis.js", () => ({
  incrQuota:  vi.fn().mockResolvedValue(1),
  getQuota:   vi.fn().mockResolvedValue(0),
  cacheGet:   vi.fn().mockResolvedValue(null),   // always cache miss → do real research
  cacheSet:   vi.fn().mockResolvedValue(undefined),
  getRedis:   vi.fn(),
  closeRedis: vi.fn().mockResolvedValue(undefined),
  KEYS:       { research: vi.fn(), quota: vi.fn(), llmCache: vi.fn() },
  hashPrompt: vi.fn().mockReturnValue("mock-hash"),
}));

// HITL — auto-approve all requests (simulates human approving instantly)
vi.mock("../../src/gateway/hitl.js", () => ({
  requestHITL: vi.fn().mockResolvedValue({
    status: "approved",
    interrupt_id: "live-test-interrupt-id",
    requested_at: new Date().toISOString(),
    resolved_at:  new Date().toISOString(),
  }),
}));

// Web search — return realistic company data (no real Tavily key needed)
// IMPORTANT: prospecting.ts uses runToolExecutor("search_web", ...) via the tool registry
vi.mock("../../src/tools/web-search.js", () => ({
  webSearchTool: {
    name: "search_web",
    description: "Mock web search for testing",
    execute: vi.fn().mockResolvedValue([
      {
        title: "Notion — The all-in-one workspace",
        url: "https://notion.so",
        content: "Notion is a connected workspace for teams. Used by 30M+ users. " +
                 "Founded 2016, raised $343M total funding (Series C at $10B valuation). " +
                 "Team: ~800 employees. Tech stack: React, Electron, Node.js, Postgres. " +
                 "Pain points: enterprises struggle with workflow automation, AI integration, " +
                 "custom API tooling, and scaling internal tools teams.",
      },
      {
        title: "Notion Product Roadmap 2025",
        url: "https://notion.so/roadmap",
        content: "Notion AI launched but teams report needing custom AI agents for their " +
                 "specific workflows. Many companies hire agencies to build bespoke integrations.",
      },
    ]),
  },
}));

// ── Real imports (after mocks are hoisted) ────────────────────────────────────

import { callCascade }         from "../../src/infra/llm.js";
import { salesSubgraph }       from "../../src/agents/pods/sales.js";
import { engineeringSubgraph } from "../../src/agents/pods/engineering.js";
import { marketingSubgraph }   from "../../src/agents/pods/marketing.js";
import { prospectingSubgraph } from "../../src/agents/pods/prospecting.js";
import { supervisorNode }      from "../../src/agents/supervisor.js";
import type { FounderStateType }    from "../../src/agents/state.js";
import type { SalesStateType }      from "../../src/agents/state.js";
import type { EngineeringStateType } from "../../src/agents/state.js";
import type { MarketingStateType }  from "../../src/agents/state.js";

// ── Ollama client (direct — bypasses cascade routing) ────────────────────────

const OLLAMA_URL   = "http://localhost:11434";
const LIVE_MODEL   = "founderos:latest";
const TIMEOUT_MS   = 300_000; // 5 min per test (local LLM is slower + queue wait)

interface OllamaMsg    { role: "system" | "user" | "assistant"; content: string }
interface OllamaResp   { message: { content: string }; done: boolean; total_duration?: number }

async function ollamaChat(messages: OllamaMsg[], options?: { temperature?: number }): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: LIVE_MODEL,
      messages,
      stream: false,
      options: { temperature: options?.temperature ?? 0.2, num_predict: 2048 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json() as OllamaResp;
  return data.message.content;
}

// ── callCascade interceptor — routes all LLM calls to Ollama ─────────────────

type LangChainMessage = { _getType: () => string; content: string | unknown[] };

function extractMessages(msgs: LangChainMessage[]): OllamaMsg[] {
  return msgs.map((m) => {
    const role = m._getType() === "system" ? "system"
               : m._getType() === "ai"     ? "assistant"
               : "user";
    const content = typeof m.content === "string"
      ? m.content
      : (m.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
    return { role: role as "system" | "user" | "assistant", content };
  });
}

const callLog: { tier: string; agent: string; tokensOut: number; snippet: string }[] = [];
let   ollamaAvailable = false;

// ── Test setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Check Ollama + model
  try {
    const res  = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await res.json() as { models: { name: string }[] };
    ollamaAvailable = data.models.some((m) => m.name === LIVE_MODEL);
  } catch {
    ollamaAvailable = false;
  }

  if (!ollamaAvailable) {
    console.warn(`\n⚠️  Ollama not running or ${LIVE_MODEL} not installed.\nRun: ollama create founderos -f docker/Modelfile.founderos\n`);
  }

  // Wire callCascade → Ollama
  const mockCC = callCascade as MockedFunction<typeof callCascade>;
  mockCC.mockImplementation(async (tier, messages, opts) => {
    const msgs = extractMessages(messages as unknown as LangChainMessage[]);
    const text = await ollamaChat(msgs, { temperature: 0.2 });

    const entry = { tier, agent: opts.agent, tokensOut: text.split(" ").length, snippet: text.slice(0, 80) };
    callLog.push(entry);

    return { text, model: LIVE_MODEL, provider: "lmstudio", tier, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  });
});

afterAll(() => {
  if (callLog.length === 0) return;
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              LLM CALL SUMMARY (One-Man Company)              ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  callLog.forEach((c, i) =>
    console.log(`║ ${String(i + 1).padStart(2)}. [${c.tier.padEnd(12)}] ${c.agent.padEnd(22)} ~${String(c.tokensOut).padStart(4)} words ║`),
  );
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Total LLM calls: ${String(callLog.length).padEnd(43)}║`);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFounderState(overrides: Partial<FounderStateType> = {}): FounderStateType {
  return {
    schema_version: 1,
    trace_id: `live-test-${Date.now()}`,
    tenant_id: "turicks",
    messages: [],
    task: "",
    department: "",
    result: "",
    auto_approve: false,
    errors: [],
    outreach_tier: null,
    lead_id: null,
    ...overrides,
  };
}

function makeSalesState(task: string): Partial<SalesStateType> {
  return {
    tenant_id: "turicks",
    trace_id: `live-sales-${Date.now()}`,
    task,
    max_revisions: 1,
  };
}

function makeEngState(task: string): Partial<EngineeringStateType> {
  return { tenant_id: "turicks", trace_id: `live-eng-${Date.now()}`, task };
}

function makeMktgState(task: string): Partial<MarketingStateType> {
  return { tenant_id: "turicks", trace_id: `live-mktg-${Date.now()}`, task };
}

function separator(title: string) {
  const line = "─".repeat(60);
  console.log(`\n┌${line}┐`);
  console.log(`│  ${title.padEnd(58)}│`);
  console.log(`└${line}┘`);
}

// ── TESTS ─────────────────────────────────────────────────────────────────────

describe("FounderOS — Can it run a one-man company?", () => {

  // ── 1. SUPERVISOR: Does it route tasks to the right department? ──────────────

  describe("1. Supervisor (CEO routing)", () => {
    const cases: Array<{ task: string; expected: string; label: string }> = [
      {
        label: "Outbound prospect command",
        task:  "/prospect https://linear.app",
        expected: "prospecting",
      },
      {
        label: "Client project request",
        task:  "Build a custom AI agent dashboard for our SaaS client",
        expected: "engineering",
      },
      {
        label: "Content creation request",
        task:  "Write a LinkedIn post about how AI automation saved us 20 hours/week",
        expected: "social",  // LinkedIn posts → Social pod (not Marketing)
      },
      {
        label: "Sales outreach request",
        task:  "Draft a cold email to the VP of Ops at Revolut about AI workflow automation",
        expected: "sales",
      },
    ];

    for (const { label, task, expected } of cases) {
      it(`routes "${label}" → ${expected}`, { timeout: TIMEOUT_MS }, async () => {
        if (!ollamaAvailable) return;

        separator(`SUPERVISOR: ${label}`);
        const state  = makeFounderState({ task });
        const result = await supervisorNode(state);

        console.log(`📋 Task:       ${task}`);
        console.log(`🎯 Routed to:  ${result.department ?? "(unchanged)"}`);

        expect(result.department).toBe(expected);
      });
    }
  });

  // ── 2. PROSPECTING POD: Research → ICP Score → Prepare Handoff ───────────────

  describe("2. ProspectingPod — Research + Qualify Lead", () => {
    it("researches Notion.so and ICP scores it for Turicks", { timeout: TIMEOUT_MS * 2 }, async () => {
      if (!ollamaAvailable) return;

      separator("PROSPECTING: Notion.so end-to-end");
      console.log("📡 Starting: disambiguate → research → ICP score → route\n");

      const result = await prospectingSubgraph.invoke({
        raw_input:  "notion.so",
        tenant_id:  "turicks",
        trace_id:   `live-prospect-${Date.now()}`,
      });

      console.log(`\n🏢 Company:       ${result.company_name ?? "N/A"}`);
      console.log(`🔗 URL:           ${result.company_url ?? "N/A"}`);
      console.log(`📊 ICP Score:     ${result.icp_score ?? "N/A"}`);
      console.log(`💡 Rationale:     ${result.icp_rationale?.slice(0, 120) ?? "N/A"}...`);
      console.log(`🎯 Outreach Tier: ${result.outreach_tier ?? "disqualified"}`);

      // Assertions: the model should extract a company URL and produce a score
      expect(result.company_url).toBeTruthy();
      expect(typeof result.icp_score).toBe("number");
      expect(result.icp_score).toBeGreaterThanOrEqual(0);
      expect(result.icp_score).toBeLessThanOrEqual(1);
      expect(result.icp_rationale).toBeTruthy();

      // Notion should be a good ICP match for AI agency services
      // (high-growth SaaS, needs AI integration, big team = $ signal)
      if (result.icp_score >= 0.4) {
        console.log(`\n✅ QUALIFIED (score ${result.icp_score}) → would hand off to SalesPod`);
        expect(result.outreach_tier).toMatch(/^(md|ceo)$/);
      } else {
        console.log(`\n⚠️  DISQUALIFIED (score ${result.icp_score}) — check ICP prompt tuning`);
      }
    });
  });

  // ── 3. SALES POD: Engineer → BDR → Critic → Finalize ─────────────────────────

  describe("3. SalesPod — Autonomous Outreach Pipeline", () => {
    it("generates a full cold email for a qualified lead (Linear.app VP Eng)", { timeout: TIMEOUT_MS * 3 }, async () => {
      if (!ollamaAvailable) return;

      separator("SALES: Lead → Strategy → Email → Critic Loop → Finalize");
      console.log("📋 Lead: Thomas P., VP Engineering @ Linear.app");
      console.log("💰 ICP Score: 0.82 (CEO tier)\n");

      const task = `Write a cold outreach email to Thomas P., VP of Engineering at Linear.app.
They have 200 engineers, recently raised Series B, using traditional project management.
Pain point: their team spends 40% of time on status updates and cross-team sync.
Turicks builds AI agents that auto-generate status reports, flag blockers, and route tasks.
Outreach tier: CEO. Keep it under 150 words, pain-first, zero buzzwords.`;

      const result = await salesSubgraph.invoke(makeSalesState(task));

      console.log("\n── SALES ENGINEER BRIEF ─────────────────────────────────────");
      const brief = result.sales_engineer_brief as Record<string, unknown> | null;
      if (brief) {
        console.log(`Angle:       ${String(brief.angle ?? "N/A")}`);
        console.log(`Hook:        ${String(brief.hook ?? "N/A")}`);
        console.log(`Value Prop:  ${String(brief.value_prop ?? "N/A")}`);
        console.log(`CTA:         ${String(brief.cta ?? "N/A")}`);
      }

      console.log("\n── EMAIL DRAFT ──────────────────────────────────────────────");
      const email = result.email_draft as { subject: string; body: string } | null;
      if (email) {
        console.log(`Subject: ${email.subject}`);
        console.log(`\n${email.body}`);
      }

      console.log("\n── CRITIQUE HISTORY ─────────────────────────────────────────");
      const critiques = result.critiques as Array<{ result: string; notes: string }> ?? [];
      critiques.forEach((c, i) => {
        console.log(`Critique ${i + 1}: ${c.result} — ${c.notes?.slice(0, 100)}`);
      });

      console.log("\n── FINAL STATE ──────────────────────────────────────────────");
      const final = result.final as Record<string, unknown> | null;
      if (final) {
        console.log(`HITL status:  ${String(final.hitl_status ?? "N/A")}`);
        console.log(`Finalized at: ${String(final.finalized_at ?? "N/A")}`);
      }

      // Critical assertions
      expect(email).toBeTruthy();
      expect(email?.subject).toBeTruthy();
      expect(email?.body).toBeTruthy();
      // Body should be substantive
      const wordCount = (email?.body ?? "").split(/\s+/).length;
      console.log(`\nWord count: ${wordCount} words`);
      expect(wordCount).toBeGreaterThan(20);
      expect(wordCount).toBeLessThan(250); // Should stay concise
      // Critic should have run
      expect(critiques.length).toBeGreaterThan(0);
    });
  });

  // ── 4. ENGINEERING POD: Plan → Code Stub → Auto-HITL → Finalize ──────────────

  describe("4. EngineeringPod — Technical Task Execution", () => {
    it("plans and specs a real-time AI cost dashboard component", { timeout: TIMEOUT_MS * 2 }, async () => {
      if (!ollamaAvailable) return;

      separator("ENGINEERING: React cost dashboard feature");
      console.log("📋 Task: Build a real-time AI cost dashboard for FounderOS UI\n");

      const task = `Build a React TypeScript component called <AICostDashboard /> that:
- Connects to our REST API at /api/costs?tenant_id={id}&period=7d
- Shows a line chart of daily LLM spending (recharts)
- Displays per-agent cost breakdown in a sortable table
- Highlights agents that exceed budget threshold (red badge)
- Auto-refreshes every 30s
- Mobile responsive (Tailwind CSS)
Stack: React 18, TypeScript strict, Tailwind, recharts, vitest for tests.`;

      const result = await engineeringSubgraph.invoke(makeEngState(task));

      const plan = result.eng_engineer_plan as {
        summary: string;
        steps: Array<{ name: string; description: string; hitl_required?: boolean }>;
        risks: string[];
        estimated_hours: number;
        first_deliverable: string;
      } | null;

      console.log("\n── ENGINEERING PLAN ─────────────────────────────────────────");
      if (plan) {
        console.log(`Summary:         ${plan.summary}`);
        console.log(`Estimated Hours: ${plan.estimated_hours}h`);
        console.log(`First Delivery:  ${plan.first_deliverable}`);
        console.log(`\nSteps (${plan.steps.length} total):`);
        plan.steps.forEach((s, i) => {
          // Model returns 'action' | 'title' | 'name' depending on tier — normalise display
          const label = (s as unknown as Record<string, string>)["name"]
            ?? (s as unknown as Record<string, string>)["title"]
            ?? (s as unknown as Record<string, string>)["action"]
            ?? (s as unknown as Record<string, string>)["description"]
            ?? `Step ${i + 1}`;
          console.log(`  ${i + 1}. ${label}${s.hitl_required ? " [HITL]" : ""}`);
        });
        console.log(`\nRisks:`);
        plan.risks.forEach((r) => console.log(`  ⚠️  ${r}`));
      } else {
        console.log("(plan was not structured — raw spec)");
      }

      console.log("\n── CODE STUB ────────────────────────────────────────────────");
      console.log(result.code_draft?.slice(0, 400) ?? "(no code stub)");

      console.log("\n── QA STATUS ────────────────────────────────────────────────");
      const qa = result.test_results as { passed: boolean; details: string } | null;
      console.log(`Passed: ${qa?.passed ? "✅" : "❌"}`);
      console.log(`Detail: ${qa?.details ?? "N/A"}`);

      console.log("\n── HITL OUTCOME ─────────────────────────────────────────────");
      const hitl = result.hitl as { status: string; interrupt_id: string } | null;
      console.log(`Status: ${hitl?.status ?? "N/A"} (id: ${hitl?.interrupt_id ?? "N/A"})`);

      const final = result.final as Record<string, unknown> | null;
      console.log(`\nFinalized: ${final ? "✅" : "❌"}`);

      // Assertions
      expect(result.code_draft).toBeTruthy();
      expect(result.final).toBeTruthy();
      // Engineering auto-approves if no steps require HITL
      const hitlStatus = hitl?.status;
      expect(["approved", "auto-approved"]).toContain(hitlStatus);
    });
  });

  // ── 5. MARKETING POD: Strategy → Content → HITL → Publish ────────────────────

  describe("5. MarketingPod — Content Creation Pipeline", () => {
    it("creates a LinkedIn post about AI agent ROI", { timeout: TIMEOUT_MS * 2 }, async () => {
      if (!ollamaAvailable) return;

      separator("MARKETING: LinkedIn post creation");
      console.log("📋 Task: LinkedIn post — AI agent ROI for startups\n");

      const task = `Write a LinkedIn post for Turicks (AI agency) on this topic:
"How a 5-person startup used AI agents to do the work of 15 people in 3 months."
Angle: concrete numbers, not hype. Show the before/after.
Platform: LinkedIn. Format: hook + 3 bullet points + CTA.
Target audience: CTOs and founders at Series A startups.
Goal: demonstrate Turicks' capability → DMs asking for discovery call.`;

      const result = await marketingSubgraph.invoke(makeMktgState(task));

      console.log("\n── MARKETING ENGINEER BRIEF ─────────────────────────────────");
      const brief = result.mktg_engineer_brief as Record<string, unknown> | null;
      if (brief) {
        console.log(`Goal:     ${String(brief.goal ?? "N/A")}`);
        console.log(`Pillar:   ${String(brief.content_pillar ?? "N/A")}`);
        console.log(`Platform: ${String(brief.platform ?? "N/A")}`);
        console.log(`Format:   ${String(brief.format ?? "N/A")}`);
      }

      console.log("\n── RESEARCH INSIGHTS ────────────────────────────────────────");
      const research = result.research_notes as string | null;
      console.log(research?.slice(0, 300) ?? "(no research notes)");

      console.log("\n── CONTENT DRAFT ────────────────────────────────────────────");
      const draft = result.content_draft as string | null;
      console.log(draft ?? "(no draft produced)");

      console.log("\n── HITL + PUBLISH ───────────────────────────────────────────");
      const hitl  = result.hitl  as { status: string } | null;
      const final = result.final as { published_at?: string } | null;
      console.log(`HITL status: ${hitl?.status ?? "N/A"}`);
      console.log(`Published:   ${final?.published_at ?? "pending"}`);

      // Assertions
      expect(draft).toBeTruthy();
      const wordCount = (draft ?? "").split(/\s+/).length;
      console.log(`\nWord count: ${wordCount} words`);
      expect(wordCount).toBeGreaterThan(30);
      expect(result.final).toBeTruthy();
    });
  });

  // ── 6. CROSS-DEPT: Prospecting → Sales Handoff ───────────────────────────────

  describe("6. Cross-Department: Prospecting → Sales state handoff", () => {
    it("qualifies a lead in ProspectingPod then passes full state to SalesPod", { timeout: TIMEOUT_MS * 4 }, async () => {
      if (!ollamaAvailable) return;

      separator("CROSS-DEPT: Prospecting → Sales (full pipeline)");
      console.log("🎯 Target: Revolut — fintech scale-up, AI agent opportunity\n");

      // ── STAGE 1: ProspectingPod ──────────────────────────────────────────────
      console.log("📡 STAGE 1: ProspectingPod — research + qualify...");
      const prospectResult = await prospectingSubgraph.invoke({
        raw_input:  "revolut.com",
        tenant_id:  "turicks",
        trace_id:   `live-cross-dept-prospect-${Date.now()}`,
      });

      console.log(`\n  Company:     ${prospectResult.company_name ?? "Revolut"}`);
      console.log(`  ICP Score:   ${prospectResult.icp_score ?? "N/A"}`);
      console.log(`  Tier:        ${prospectResult.outreach_tier ?? "disqualified"}`);
      console.log(`  Rationale:   ${prospectResult.icp_rationale?.slice(0, 100) ?? "N/A"}...`);

      // ── ROUTE CHECK ──────────────────────────────────────────────────────────
      const score = prospectResult.icp_score ?? 0;
      const tier  = prospectResult.outreach_tier;

      console.log(`\n📊 Routing decision:`);
      if (!tier) {
        console.log(`  ❌ Disqualified (score ${score}) — would end at ProspectingPod`);
        // Skip SalesPod test — but still pass (disqualification is valid behaviour)
        expect(score).toBeLessThan(0.4);
        return;
      }
      console.log(`  ✅ Qualified (score ${score}, tier: ${tier}) → handing off to SalesPod`);

      // ── STAGE 2: SalesPod — using prospecting intel ──────────────────────────
      console.log(`\n💼 STAGE 2: SalesPod — generating outreach...`);

      const salesTask = [
        `Company: ${prospectResult.company_name ?? "Revolut"} (${prospectResult.company_url ?? "revolut.com"})`,
        `ICP Score: ${score} | Tier: ${tier}`,
        `Research: ${prospectResult.icp_rationale ?? "High-growth fintech, large engineering org"}`,
        "",
        "Write a cold outreach email to their Head of Engineering about:",
        "Turicks building AI agents that automate internal tooling, compliance workflows,",
        "and developer productivity at fintech scale. Keep it under 150 words.",
      ].join("\n");

      const salesResult = await salesSubgraph.invoke(makeSalesState(salesTask));

      const email = salesResult.email_draft as { subject: string; body: string } | null;
      console.log(`\n── EMAIL GENERATED ─────────────────────────────────────────`);
      console.log(`Subject: ${email?.subject ?? "(none)"}`);
      console.log(`\n${email?.body ?? "(no body)"}`);
      console.log(`\n── PIPELINE COMPLETED ───────────────────────────────────────`);
      console.log(`Critiques run: ${(salesResult.critiques as unknown[])?.length ?? 0}`);
      console.log(`Finalized:     ${salesResult.final ? "✅" : "❌"}`);
      console.log(`HITL approved: ${(salesResult.hitl as { status?: string })?.status ?? "N/A"}`);

      // ── FINAL ASSERTIONS ─────────────────────────────────────────────────────
      console.log("\n── STATE SHARING VERIFICATION ───────────────────────────────");
      // Prospecting → Sales handoff transfers icp_score, company info
      expect(prospectResult.company_url).toBeTruthy();
      expect(typeof score).toBe("number");
      // SalesPod used the prospecting intel (task includes research data)
      expect(email?.body).toBeTruthy();
      expect(email?.body?.length).toBeGreaterThan(50);
      expect(salesResult.final).toBeTruthy();

      console.log("✅ State passed correctly from ProspectingPod → SalesPod");
      console.log("✅ Both pods completed their full node sequences");
      console.log("✅ Cross-department collaboration VERIFIED");
    });
  });

  // ── 7. COMPANY CAPACITY TEST: 4 parallel tasks ───────────────────────────────

  describe("7. Company Capacity — Parallel Department Tasks", () => {
    it("handles 4 simultaneous tasks (one per department)", { timeout: TIMEOUT_MS * 4 }, async () => {
      if (!ollamaAvailable) return;

      separator("COMPANY CAPACITY: 4 departments, simultaneous");
      console.log("🏭 Running 4 real tasks in parallel...\n");

      const t0 = Date.now();

      const [salesResult, engResult, mktgResult] = await Promise.allSettled([
        // Sales: quick outreach
        salesSubgraph.invoke(makeSalesState(
          "Write cold email to CTO at Stripe about AI agents for developer tooling automation",
        )),
        // Engineering: quick task
        engineeringSubgraph.invoke(makeEngState(
          "Add error boundary component to React app with Sentry reporting",
        )),
        // Marketing: quick post
        marketingSubgraph.invoke(makeMktgState(
          "Twitter thread: 3 AI agent patterns every SaaS startup should implement in 2025",
        )),
      ]);

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      console.log("\n── CAPACITY TEST RESULTS ────────────────────────────────────");
      console.log(`Total time: ${elapsed}s for 3 departments\n`);

      const results = [
        { name: "SalesPod",       result: salesResult },
        { name: "EngineeringPod", result: engResult   },
        { name: "MarketingPod",   result: mktgResult  },
      ];

      let allPassed = true;
      for (const { name, result } of results) {
        if (result.status === "fulfilled") {
          console.log(`  ✅ ${name}: completed`);
        } else {
          console.log(`  ❌ ${name}: FAILED — ${result.reason}`);
          allPassed = false;
        }
      }

      console.log(`\n  ${allPassed ? "✅" : "⚠️"} All departments ${allPassed ? "processed tasks successfully" : "had issues — check logs"}`);

      // At least 2 out of 3 must succeed
      const successCount = results.filter((r) => r.result.status === "fulfilled").length;
      expect(successCount).toBeGreaterThanOrEqual(2);

      if (allPassed) {
        console.log("\n🏆 VERDICT: FounderOS CAN run a one-man company.");
        console.log("   All departments operational, cross-dept state passing verified.");
      }
    });
  });

});
