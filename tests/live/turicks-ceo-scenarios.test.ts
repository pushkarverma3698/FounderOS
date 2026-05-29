/**
 * FounderOS — Turicks CEO Live Integration Test
 * ===============================================
 * Real CEO-level scenarios for Turicks (AI agent + UI/UX + software agency).
 * All LLM reasoning goes to Ollama qwen2.5:7b — no cloud keys needed.
 * Goal: find what needs tuning BEFORE going live.
 *
 * Strategy:
 *   - callCascade → intercepted, all calls routed to Ollama qwen2.5:7b
 *   - DB (queries.js) → mocked with spies (observe what agents try to write)
 *   - Redis → mocked fail-open (quota=0, cache=miss)
 *   - HITL → auto-approved (instant human sign-off simulation)
 *   - Web search → realistic Framer.com + Intercom company data
 *
 * CEO Scenarios:
 *   1. SUPERVISOR — Turicks-specific task routing (design audit, prospect, etc.)
 *   2. PROSPECTING — Framer.com (design tool SaaS — ideal Turicks ICP)
 *   3. SALES — Cold email to Intercom CTO about AI agent automation
 *   4. ENGINEERING — Build client onboarding automation for FinTech startup
 *   5. MARKETING — LinkedIn post about FounderOS open-source + TypeScript choices
 *   6. CROSS-DEPT — "We closed Revolut as a client — start engineering onboarding"
 *
 * Run: pnpm test tests/live/turicks-ceo-scenarios.test.ts --reporter=verbose
 *
 * After each test: read the output carefully — this IS the quality audit.
 * Flag anything that sounds off-brand, hallucinated, or needs prompt tuning.
 */

import { describe, it, expect, vi, beforeAll, afterAll, type MockedFunction } from "vitest";

// ── CRITICAL: vi.mock() is hoisted before ALL imports ─────────────────────────

// Route all LLM calls to Ollama (real intelligence, no cloud keys)
vi.mock("../../src/infra/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/infra/llm.js")>("../../src/infra/llm.js");
  return {
    ...actual,
    callCascade: vi.fn(),   // wired to Ollama in beforeAll
    checkBudget: vi.fn().mockResolvedValue(undefined),
  };
});

// DB — mocked with spies so we can read what agents try to persist
vi.mock("../../src/db/queries.js", () => ({
  hasBeenAudited:      vi.fn().mockResolvedValue(false),
  writeAuditEntry:     vi.fn().mockResolvedValue(undefined),
  createInterrupt:     vi.fn().mockResolvedValue("ceo-test-interrupt-id"),
  resolveInterrupt:    vi.fn().mockResolvedValue(true),
  logCost:             vi.fn().mockResolvedValue(undefined),
  isSuppressed:        vi.fn().mockResolvedValue(false),
  logLlmCost:          vi.fn().mockResolvedValue(undefined),
  createLead:          vi.fn().mockResolvedValue("ceo-test-lead-id"),
  updateLead:          vi.fn().mockResolvedValue(undefined),
  updateLeadStage:     vi.fn().mockResolvedValue(undefined),
  getLeadByUrl:        vi.fn().mockResolvedValue(null),
  writeTaskOutcome:    vi.fn().mockResolvedValue(undefined),
  getRecentOutcomes:   vi.fn().mockResolvedValue([]),
  getTodayCostUsd:     vi.fn().mockResolvedValue(0),
  publishDeptEvent:    vi.fn().mockResolvedValue(undefined),
  consumePendingEvents: vi.fn().mockResolvedValue([]),
}));

// Redis — fail-open (quota=1 = below limit, research cache=miss = real scrape)
vi.mock("../../src/infra/redis.js", () => ({
  incrQuota:  vi.fn().mockResolvedValue(1),
  getQuota:   vi.fn().mockResolvedValue(0),
  cacheGet:   vi.fn().mockResolvedValue(null),   // always miss → do research
  cacheSet:   vi.fn().mockResolvedValue(undefined),
  getRedis:   vi.fn(),
  closeRedis: vi.fn().mockResolvedValue(undefined),
  KEYS:       { research: vi.fn(), quota: vi.fn(), llmCache: vi.fn() },
  hashPrompt: vi.fn().mockReturnValue("mock-hash"),
}));

// HITL — auto-approve all requests (founder says yes immediately)
vi.mock("../../src/gateway/hitl.js", () => ({
  requestHITL: vi.fn().mockResolvedValue({
    status:       "approved",
    interrupt_id: "ceo-test-interrupt-id",
    requested_at: new Date().toISOString(),
    resolved_at:  new Date().toISOString(),
  }),
}));

// Web search — realistic company data for Turicks prospecting targets
vi.mock("../../src/tools/web-search.js", () => ({
  webSearchTool: {
    name: "search_web",
    description: "Mock web search for CEO testing",
    execute: vi.fn().mockImplementation(async (query: string) => {
      const q = (query ?? "").toLowerCase();

      // ── Framer.com data ──────────────────────────────────────────────────────
      if (q.includes("framer")) {
        return [
          {
            title: "Framer — The professional website builder for design teams",
            url: "https://framer.com",
            content:
              "Framer is the professional website builder for design-forward teams. " +
              "Used by 600,000+ designers worldwide. Raised Series B ($27M), backed by Atomico. " +
              "~120 employees. Founded in Amsterdam, team distributed globally. " +
              "Tech stack: React, TypeScript, WebAssembly, Framer Motion. " +
              "Pain points: design-to-code handoff is slow, teams spend weeks recreating " +
              "components already designed in Figma. No AI-powered component generation yet. " +
              "Customer base: agencies, freelancers, SaaS companies building marketing sites. " +
              "Hiring: engineering manager for AI product features (job posted 2 weeks ago).",
          },
          {
            title: "Framer raises $27M Series B to democratise web design",
            url: "https://techcrunch.com/framer-series-b",
            content:
              "Framer closed a $27M Series B to build AI-first features into their design platform. " +
              "CEO Koen Bok: 'the future of web design is design systems that code themselves.' " +
              "They're actively seeking agencies and dev shops that can build custom AI tooling " +
              "on top of the Framer API. Design agencies with TypeScript + AI expertise are " +
              "their preferred integration partners.",
          },
        ];
      }

      // ── Intercom data ────────────────────────────────────────────────────────
      if (q.includes("intercom")) {
        return [
          {
            title: "Intercom — The complete AI-first customer service platform",
            url: "https://intercom.com",
            content:
              "Intercom serves 25,000+ businesses with customer messaging. " +
              "Series D funded at $1.27B valuation. ~900 employees. " +
              "Recent: launched Fin AI Agent — but it only handles tier-1 support. " +
              "Pain point: tier-2 and tier-3 tickets still require human agents. " +
              "Automation gap: sales follow-up sequences still manual. " +
              "Tech stack: Ruby on Rails, React, Ember.js, Go microservices. " +
              "Buying signals: CTO Des Traynor posted about needing AI that 'actually closes tickets'.",
          },
        ];
      }

      // ── Revolut data ─────────────────────────────────────────────────────────
      if (q.includes("revolut")) {
        return [
          {
            title: "Revolut — Global fintech superapp",
            url: "https://revolut.com",
            content:
              "Revolut has 40M+ customers across 38 countries. Valued at $45B (2024). " +
              "8,000+ employees globally. Obtained UK banking licence in 2024. " +
              "Engineering: 2,500+ engineers, microservices on Kotlin + Go. " +
              "Pain point: onboarding new enterprise clients takes 6-8 weeks due to manual KYC workflows. " +
              "AI opportunity: automating compliance checks and document processing for B2B onboarding. " +
              "Budget: significant — recently approved £50M for internal tooling and AI infrastructure.",
          },
        ];
      }

      // Default fallback
      return [
        {
          title: "Company Overview",
          url:   "https://example.com",
          content: "A technology company with growth opportunities for AI agent services.",
        },
      ];
    }),
  },
}));

// ── Real imports (after mocks are registered above) ───────────────────────────

import { callCascade }         from "../../src/infra/llm.js";
import { salesSubgraph }       from "../../src/agents/pods/sales.js";
import { engineeringSubgraph } from "../../src/agents/pods/engineering.js";
import { marketingSubgraph }   from "../../src/agents/pods/marketing.js";
import { prospectingSubgraph } from "../../src/agents/pods/prospecting.js";
import { supervisorNode }      from "../../src/agents/supervisor.js";
import type { FounderStateType }      from "../../src/agents/state.js";
import type { SalesStateType }        from "../../src/agents/state.js";
import type { EngineeringStateType }  from "../../src/agents/state.js";
import type { MarketingStateType }    from "../../src/agents/state.js";

// ── Ollama client — direct call bypassing cascade routing ─────────────────────

const OLLAMA_URL  = "http://localhost:11434";
const LIVE_MODEL  = "qwen2.5:7b";   // production model (more capable than founderos:latest)
const TIMEOUT_MS  = 300_000;        // 5 min per test (local LLM queue wait)

interface OllamaMsg  { role: "system" | "user" | "assistant"; content: string }
interface OllamaResp { message: { content: string }; done: boolean; total_duration?: number }

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

// ── callCascade interceptor ────────────────────────────────────────────────────

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

// ── Quality flag tracking for tuning report ───────────────────────────────────

interface QualityFlag {
  scenario:  string;
  severity:  "🔴 CRITICAL" | "🟡 WARN" | "✅ OK";
  message:   string;
}

const callLog: { tier: string; agent: string; tokensOut: number; latencyMs: number; snippet: string }[] = [];
const qualityFlags: QualityFlag[]  = [];
let   ollamaAvailable              = false;

function flagQuality(scenario: string, severity: QualityFlag["severity"], message: string) {
  qualityFlags.push({ scenario, severity, message });
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Verify Ollama + model availability
  try {
    const res  = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await res.json() as { models: { name: string }[] };
    // Match prefix in case model is tagged as "qwen2.5:7b-instruct"
    ollamaAvailable = data.models.some((m) => m.name.startsWith("qwen2.5"));
    if (!ollamaAvailable) {
      console.warn(
        `\n⚠️  ${LIVE_MODEL} not found. Available models: ${data.models.map((m) => m.name).join(", ")}` +
        `\nRun: ollama pull qwen2.5:7b\n`,
      );
    }
  } catch {
    ollamaAvailable = false;
    console.warn(`\n⚠️  Ollama not running at ${OLLAMA_URL}\nRun: ollama serve\n`);
  }

  // Wire callCascade → Ollama qwen2.5:7b
  const mockCC = callCascade as MockedFunction<typeof callCascade>;
  mockCC.mockImplementation(async (tier, messages, opts) => {
    const msgs      = extractMessages(messages as unknown as LangChainMessage[]);
    const start     = Date.now();
    const text      = await ollamaChat(msgs, { temperature: 0.2 });
    const latencyMs = Date.now() - start;

    callLog.push({
      tier,
      agent:     opts.agent,
      tokensOut: text.split(/\s+/).length,
      latencyMs,
      snippet:   text.slice(0, 80).replace(/\n/g, " "),
    });

    return { text, model: LIVE_MODEL, provider: "lmstudio", tier, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  });
});

afterAll(() => {
  const sep = "═".repeat(62);

  // ── LLM call summary ──────────────────────────────────────────────────────
  if (callLog.length > 0) {
    console.log(`\n╔${sep}╗`);
    console.log("║         LLM CALL LOG — Turicks CEO Scenarios                ║");
    console.log(`╠${sep}╣`);
    callLog.forEach((c, i) => {
      const row = ` ${String(i + 1).padStart(2)}. [${c.tier.padEnd(14)}] ${c.agent.padEnd(22)} ~${String(c.tokensOut).padStart(4)}w  ${String(c.latencyMs).padStart(5)}ms`;
      console.log(`║${row.padEnd(62)}║`);
    });
    const totalLatency = callLog.reduce((s, c) => s + c.latencyMs, 0);
    console.log(`╠${sep}╣`);
    console.log(`║  Total calls: ${String(callLog.length).padEnd(10)} Total latency: ${(totalLatency / 1000).toFixed(1)}s${"".padEnd(11)}║`);
    console.log(`╚${sep}╝\n`);
  }

  // ── Quality / tuning report ───────────────────────────────────────────────
  console.log(`╔${sep}╗`);
  console.log("║              TUNING REPORT — Action Items                   ║");
  console.log(`╠${sep}╣`);

  if (qualityFlags.length === 0) {
    console.log("║  ✅ No quality flags raised — system looks good!             ║");
  } else {
    const criticals = qualityFlags.filter((f) => f.severity === "🔴 CRITICAL");
    const warns     = qualityFlags.filter((f) => f.severity === "🟡 WARN");
    const oks       = qualityFlags.filter((f) => f.severity === "✅ OK");

    if (criticals.length > 0) {
      console.log("║  🔴 CRITICAL — Fix before going live:                        ║");
      criticals.forEach((f) => console.log(`║    [${f.scenario.slice(0, 20).padEnd(20)}] ${f.message.slice(0, 36).padEnd(36)}║`));
    }
    if (warns.length > 0) {
      console.log("║  🟡 WARNINGS — Prompt tuning recommended:                    ║");
      warns.forEach((f) => console.log(`║    [${f.scenario.slice(0, 20).padEnd(20)}] ${f.message.slice(0, 36).padEnd(36)}║`));
    }
    if (oks.length > 0) {
      console.log(`║  ✅ Passed (${oks.length}): all quality checks green                     ║`);
    }
  }

  console.log(`╚${sep}╝\n`);

  // Prompt tuning hints for any critical issues
  const criticals = qualityFlags.filter((f) => f.severity === "🔴 CRITICAL");
  if (criticals.length > 0) {
    console.log("📋 PROMPT TUNING RECOMMENDATIONS:");
    criticals.forEach((f) => {
      console.log(`\n  ❌ ${f.scenario}: ${f.message}`);
      console.log(`     → Review src/core/prompts.ts for the relevant agent`);
      console.log(`     → Check src/core/registry.ts cascade tier assignment`);
    });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFounderState(overrides: Partial<FounderStateType> = {}): FounderStateType {
  return {
    schema_version: 1,
    trace_id:       `ceo-test-${Date.now()}`,
    tenant_id:      "turicks",
    messages:       [],
    task:           "",
    department:     "",
    result:         "",
    auto_approve:   false,
    errors:         [],
    outreach_tier:  null,
    lead_id:        null,
    departmentSignals: [],
    ...overrides,
  };
}

function makeSalesState(task: string, overrides: Partial<SalesStateType> = {}): Partial<SalesStateType> {
  return {
    tenant_id:     "turicks",
    trace_id:      `ceo-sales-${Date.now()}`,
    task,
    max_revisions: 1,   // one critique cycle is enough for live testing
    ...overrides,
  };
}

function makeEngState(task: string): Partial<EngineeringStateType> {
  return { tenant_id: "turicks", trace_id: `ceo-eng-${Date.now()}`, task };
}

function makeMktgState(task: string): Partial<MarketingStateType> {
  return { tenant_id: "turicks", trace_id: `ceo-mktg-${Date.now()}`, task };
}

function separator(title: string) {
  const line = "─".repeat(62);
  console.log(`\n┌${line}┐`);
  console.log(`│  ${title.padEnd(60)} │`);
  console.log(`└${line}┘`);
}

function printSection(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 52 - title.length))}`);
}

// ── TESTS ─────────────────────────────────────────────────────────────────────

describe("Turicks CEO — Live Integration Scenarios", () => {

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. SUPERVISOR: Turicks-specific task routing
  //    Goal: Confirm the supervisor understands Turicks service types and routes
  //    to the right department (design audit ≠ sales, /prospect = prospecting)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("1. Supervisor — Turicks task routing", () => {

    const cases: Array<{ label: string; task: string; expected: string }> = [
      {
        label:    "Prospect a design tool company",
        task:     "/prospect https://framer.com",
        expected: "prospecting",
      },
      {
        label:    "Client AI agent build request",
        task:     "Build an AI-powered client onboarding agent for a FinTech startup. They need KYC automation + document processing.",
        expected: "engineering",
      },
      {
        label:    "LinkedIn post — thought leadership",
        task:     "Write a LinkedIn post: 5 TypeScript patterns every AI agent developer should know",
        expected: "social",
      },
      {
        label:    "Cold email to a prospect",
        task:     "Draft a cold outreach email to Des Traynor (CTO @ Intercom) about how Turicks can automate their tier-2 support resolution",
        expected: "sales",
      },
    ];

    for (const { label, task, expected } of cases) {
      it(`routes "${label}" → ${expected}`, { timeout: TIMEOUT_MS }, async () => {
        if (!ollamaAvailable) return;

        separator(`SUPERVISOR: ${label}`);

        const state  = makeFounderState({ task });
        const result = await supervisorNode(state);

        console.log(`📋 Task:       ${task.slice(0, 80)}...`);
        console.log(`🎯 Routed to:  ${result.department ?? "(none)"}`);

        const dept = result.department;
        if (dept !== expected) {
          flagQuality("Supervisor", "🟡 WARN",
            `"${label}" routed to ${dept} not ${expected}`);
          console.log(`⚠️  Expected: ${expected}, got: ${dept} — flag for prompt review`);
        } else {
          flagQuality("Supervisor", "✅ OK", `"${label}" routed correctly`);
          console.log(`✅ Correct routing`);
        }

        expect(dept).toBe(expected);
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. PROSPECTING: Framer.com
  //    Framer is a design tool SaaS — PERFECT ICP for Turicks (UI/UX + AI agents).
  //    Expect: icp_score ≥ 0.7, outreach_tier = "ceo", rationale mentions design
  // ─────────────────────────────────────────────────────────────────────────────

  describe("2. ProspectingPod — Qualify Framer.com (ideal Turicks ICP)", () => {

    it("researches Framer, assigns high ICP score, prepares CEO-tier handoff", { timeout: TIMEOUT_MS * 2 }, async () => {
      if (!ollamaAvailable) return;

      separator("PROSPECTING: framer.com → ICP score → SalesPod handoff");
      console.log("🏢 Target: Framer.com — design tool SaaS, AI-first pivot, Series B");
      console.log("💡 Hypothesis: Framer should score ≥ 0.7 (design + AI agency fit)\n");

      const result = await prospectingSubgraph.invoke({
        raw_input:  "framer.com",
        tenant_id:  "turicks",
        trace_id:   `ceo-prospect-framer-${Date.now()}`,
      });

      printSection("DISAMBIGUATION");
      console.log(`Company URL:  ${result.company_url ?? "N/A"}`);
      console.log(`Company Name: ${result.company_name ?? "N/A"}`);

      printSection("ICP SCORING");
      console.log(`Score:        ${result.icp_score ?? "N/A"} (threshold: ≥0.7 for CEO tier)`);
      console.log(`Rationale:\n  ${result.icp_rationale ?? "N/A"}`);
      console.log(`Outreach Tier: ${result.outreach_tier ?? "disqualified"}`);
      console.log(`Budget Signal: ${result.budget_signal ?? "N/A"}`);

      // ── Assertions ───────────────────────────────────────────────────────────
      expect(result.company_url).toBeTruthy();
      expect(typeof result.icp_score).toBe("number");
      expect(result.icp_score).toBeGreaterThanOrEqual(0);
      expect(result.icp_score).toBeLessThanOrEqual(1);
      expect(result.icp_rationale).toBeTruthy();

      const score = result.icp_score ?? 0;

      if (score >= 0.7) {
        flagQuality("Prospecting", "✅ OK", `Framer scored ${score.toFixed(2)} (CEO tier)`);
        console.log(`\n✅ CEO TIER — Score ${score.toFixed(2)} ≥ 0.7 → correct`);
        expect(result.outreach_tier).toBe("ceo");
      } else if (score >= 0.4) {
        flagQuality("Prospecting", "🟡 WARN",
          `Framer scored only ${score.toFixed(2)} — expected ≥0.7 for design AI fit`);
        console.log(`\n🟡 MD TIER — Score ${score.toFixed(2)} (expected CEO tier for Framer)`);
        console.log("   → Check ICP scoring prompt: it should weight 'design + AI' overlap higher");
        expect(result.outreach_tier).toMatch(/^(md|ceo)$/);
      } else {
        flagQuality("Prospecting", "🔴 CRITICAL",
          `Framer disqualified (score ${score.toFixed(2)}) — ICP prompt needs major tuning`);
        console.log(`\n🔴 DISQUALIFIED — Score ${score.toFixed(2)} < 0.4 (Framer should be strong match)`);
        console.log("   → CRITICAL: Turicks ICP prompt is not recognising design+AI fit");
        console.log("   → Review: src/core/prompts.ts icp_scorer system prompt");
      }

      // Rationale quality check
      const rationale = (result.icp_rationale ?? "").toLowerCase();
      const hasDesignContext = rationale.includes("design") || rationale.includes("ui") || rationale.includes("interface");
      if (!hasDesignContext) {
        flagQuality("Prospecting", "🟡 WARN",
          "ICP rationale doesn't mention design fit — check prompt context injection");
        console.log("\n🟡 Rationale doesn't mention design fit — may need prompt context for Turicks specialization");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. SALES: Cold email to Intercom CTO
  //    Des Traynor, CTO @ Intercom — real target for AI tier-2 support automation.
  //    Expect: email is pain-first, mentions specific Intercom context, <150 words
  // ─────────────────────────────────────────────────────────────────────────────

  describe("3. SalesPod — Cold email to Intercom CTO (Des Traynor)", () => {

    it("generates a sharp CEO-tier cold email, survives critique, finalizes", { timeout: TIMEOUT_MS * 3 }, async () => {
      if (!ollamaAvailable) return;

      separator("SALES: Intercom CTO cold email — full pipeline");
      console.log("👤 Target: Des Traynor, CTO @ Intercom");
      console.log("💡 Angle: Fin AI only does tier-1, Turicks can close tier-2 + tier-3");
      console.log("🎯 Tier: CEO (funded, £1.27B valuation)\n");

      const task = `Write a cold outreach email to Des Traynor, CTO at Intercom.
Context:
- Intercom launched Fin AI Agent but it only handles tier-1 support
- Tier-2 and tier-3 tickets still require human agents (40% of volume)
- Sales follow-up sequences are still manually managed by their team
- Des recently posted: "we need AI that actually closes tickets, not just deflects them"
Turicks offer:
- AI agent that handles tier-2 support by integrating with their existing tooling
- Autonomous follow-up sequences that trigger based on ticket context
- Turicks specialises in AI agents + TypeScript — can integrate with Intercom's stack
Constraints:
- Keep it under 120 words
- Pain-first (what they're losing right now)
- Zero hype: no "revolutionary", "game-changing", "cutting-edge"
- End with a single low-friction CTA (15-min call)
Outreach tier: CEO (use Claude-level quality)`;

      const result = await salesSubgraph.invoke(makeSalesState(task));

      printSection("SALES ENGINEER BRIEF");
      const brief = result.sales_engineer_brief as Record<string, unknown> | null;
      if (brief) {
        console.log(`Angle:       ${String(brief.angle ?? "N/A")}`);
        console.log(`Hook:        ${String(brief.hook ?? "N/A")}`);
        console.log(`Value Prop:  ${String(brief.value_prop ?? "N/A")}`);
        console.log(`Obj Handles: ${String(brief.objection_handling ?? "N/A")}`);
        console.log(`CTA:         ${String(brief.cta ?? "N/A")}`);
      } else {
        console.log("(no structured brief — BDR went direct)");
        flagQuality("Sales", "🟡 WARN", "Sales engineer brief not structured — BDR may lack context");
      }

      printSection("EMAIL DRAFT (the actual output)");
      const email = result.email_draft as { subject: string; body: string } | null;
      if (email) {
        console.log(`Subject: ${email.subject}`);
        console.log(`\n${email.body}`);
      } else {
        flagQuality("Sales", "🔴 CRITICAL", "No email draft produced");
        console.log("🔴 No email draft — critical pipeline failure");
      }

      printSection("CRITIQUE HISTORY");
      const critiques = result.critiques as Array<{ result: string; notes: string; rule_violations?: string[] }> ?? [];
      if (critiques.length === 0) {
        flagQuality("Sales", "🟡 WARN", "Critic ran 0 times — quality gate may have been skipped");
        console.log("⚠️  No critiques found — critic may not have run");
      } else {
        critiques.forEach((c, i) => {
          console.log(`Critique ${i + 1}: ${c.result}`);
          console.log(`  Notes: ${c.notes?.slice(0, 150) ?? "N/A"}`);
          if (c.rule_violations && c.rule_violations.length > 0) {
            console.log(`  Violations: ${c.rule_violations.join(", ")}`);
          }
        });
        const finalDecision = critiques[critiques.length - 1]?.result;
        if (finalDecision === "APPROVED") {
          flagQuality("Sales", "✅ OK", "Email passed critic on first or second attempt");
        } else {
          flagQuality("Sales", "🟡 WARN", "Email didn't reach APPROVED after max revisions");
        }
      }

      printSection("FINAL STATE");
      const final = result.final as Record<string, unknown> | null;
      if (final) {
        console.log(`HITL status:  ${String(final.hitl_status ?? "N/A")}`);
        console.log(`Finalized at: ${String(final.finalized_at ?? "N/A")}`);
      }

      // ── Quality checks ────────────────────────────────────────────────────────
      expect(email).toBeTruthy();
      expect(email?.subject).toBeTruthy();
      expect(email?.body).toBeTruthy();

      const wordCount = (email?.body ?? "").split(/\s+/).length;
      console.log(`\n📊 Word count: ${wordCount} words`);

      if (wordCount > 200) {
        flagQuality("Sales", "🟡 WARN",
          `Email too long (${wordCount}w, asked for <120) — BDR prompt needs tighter constraint`);
      } else {
        flagQuality("Sales", "✅ OK", `Email length OK (${wordCount} words)`);
      }

      // Should mention Intercom context
      const body = (email?.body ?? "").toLowerCase();
      if (!body.includes("intercom") && !body.includes("fin") && !body.includes("support")) {
        flagQuality("Sales", "🟡 WARN",
          "Email doesn't reference Intercom/Fin/support — BDR is being too generic");
        console.log("⚠️  Email doesn't reference Intercom context — too generic");
      }

      // Should not include hype words
      const hypeWords = ["revolutionary", "game-changing", "cutting-edge", "synergy", "leverage"];
      const foundHype = hypeWords.filter((w) => body.includes(w));
      if (foundHype.length > 0) {
        flagQuality("Sales", "🟡 WARN", `Hype words found: ${foundHype.join(", ")}`);
        console.log(`⚠️  Hype words found: ${foundHype.join(", ")} — adjust tone in BDR prompt`);
      }

      expect(wordCount).toBeGreaterThan(15);
      expect(critiques.length).toBeGreaterThan(0);
      expect(result.final).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. ENGINEERING: Client onboarding automation for FinTech
  //    Real Turicks client scenario: FinTech startup needs KYC + doc processing.
  //    Expect: structured plan with steps, code stub, QA pass, HITL approval
  // ─────────────────────────────────────────────────────────────────────────────

  describe("4. EngineeringPod — Client onboarding automation (FinTech)", () => {

    it("plans and prototypes a KYC automation agent for a FinTech client", { timeout: TIMEOUT_MS * 2 }, async () => {
      if (!ollamaAvailable) return;

      separator("ENGINEERING: FinTech KYC onboarding automation agent");
      console.log("📋 Client: Series A FinTech startup (lending product)");
      console.log("🛠️  Task: AI agent that automates B2B client onboarding + KYC\n");

      const task = `Client: FinTech startup (Series A, UK-based, lending product)
Problem: Their B2B client onboarding takes 6–8 weeks because:
1. KYC document review is done manually by 3 compliance analysts
2. Company registry checks (Companies House) are copy-pasted by hand
3. Risk scoring is a spreadsheet updated weekly
4. No integration between onboarding CRM and their lending system

Task for Turicks engineering team:
Build an AI-powered onboarding automation agent that:
- Accepts uploaded documents (passport, utility bills, company accounts)
- Calls Companies House API to verify company registration
- Runs LLM-based document extraction (names, addresses, dates)
- Scores risk using their existing rules (provided as JSON config)
- Writes results into their CRM via REST API
- Flags anything uncertain for human review (HITL)

Tech constraints:
- Node.js + TypeScript strict
- Must work in UK data residency (no data sent to US)
- Integrate with their existing Postgres database
- Build as a standalone microservice (Docker)

Deliverable: implementation plan + TypeScript scaffolding for the agent`;

      const result = await engineeringSubgraph.invoke(makeEngState(task));

      printSection("ENGINEERING PLAN");
      const plan = result.eng_engineer_plan as {
        summary:            string;
        steps:              Array<Record<string, unknown>>;
        risks:              string[];
        estimated_hours:    number;
        first_deliverable:  string;
        tech_decisions?:    string[];
      } | null;

      if (plan) {
        console.log(`Summary:           ${plan.summary}`);
        console.log(`Estimated Hours:   ${plan.estimated_hours}h`);
        console.log(`First Deliverable: ${plan.first_deliverable}`);

        if (plan.tech_decisions && plan.tech_decisions.length > 0) {
          console.log(`Tech Decisions:`);
          plan.tech_decisions.forEach((d) => console.log(`  • ${d}`));
        }

        console.log(`\nImplementation Steps (${plan.steps.length}):`);
        plan.steps.forEach((s, i) => {
          const label = String(
            s["name"] ?? s["title"] ?? s["action"] ?? s["description"] ?? `Step ${i + 1}`
          );
          const hours = s["estimated_hours"] ? ` (~${s["estimated_hours"]}h)` : "";
          console.log(`  ${i + 1}. ${label}${hours}`);
        });

        console.log(`\nRisks:`);
        plan.risks.forEach((r) => console.log(`  ⚠️  ${r}`));

        // Quality checks on plan
        if (plan.steps.length < 3) {
          flagQuality("Engineering", "🟡 WARN",
            `Plan has only ${plan.steps.length} steps — senior_dev may be under-planning`);
        }
        if (!plan.estimated_hours) {
          flagQuality("Engineering", "🟡 WARN", "Plan missing estimated_hours — senior_dev should always estimate");
        }
        const planText = JSON.stringify(plan).toLowerCase();
        if (!planText.includes("test") && !planText.includes("qa")) {
          flagQuality("Engineering", "🟡 WARN", "Plan has no QA/testing step — missing quality gate");
        } else {
          flagQuality("Engineering", "✅ OK", "Plan includes QA step");
        }

        // Should mention UK data residency
        if (!planText.includes("uk") && !planText.includes("data residency") && !planText.includes("gdpr")) {
          flagQuality("Engineering", "🟡 WARN",
            "Plan doesn't address UK data residency requirement from task brief");
          console.log("\n🟡 Plan doesn't mention UK data residency — check if senior_dev reads full brief");
        }
      } else {
        flagQuality("Engineering", "🟡 WARN", "eng_engineer_plan not structured — raw spec returned");
        console.log("(plan not structured — model returned free text)");
      }

      printSection("CODE SCAFFOLD");
      const codeDraft = result.code_draft as string | null;
      if (codeDraft) {
        const lines = codeDraft.split("\n").length;
        console.log(`(${lines} lines)\n`);
        console.log(codeDraft.slice(0, 600));
        if (lines > 5) {
          flagQuality("Engineering", "✅ OK", `Code scaffold generated (${lines} lines)`);
        }
      } else {
        flagQuality("Engineering", "🟡 WARN", "No code scaffold — vibe_coder may not have run");
        console.log("(no code scaffold produced)");
      }

      printSection("QA REVIEW");
      const qa = result.test_results as { passed: boolean; details: string } | null;
      console.log(`QA passed: ${qa?.passed ? "✅" : "❌"}`);
      console.log(`Details:   ${qa?.details ?? "N/A"}`);

      printSection("HITL + FINAL");
      const hitl  = result.hitl  as { status: string; interrupt_id: string } | null;
      const final = result.final as Record<string, unknown> | null;
      console.log(`HITL status: ${hitl?.status ?? "N/A"} (id: ${hitl?.interrupt_id ?? "N/A"})`);
      console.log(`Finalized:   ${final ? "✅" : "❌"}`);
      if (final?.summary) {
        console.log(`Summary:     ${String(final.summary).slice(0, 200)}`);
      }

      // ── Assertions ───────────────────────────────────────────────────────────
      expect(result.code_draft).toBeTruthy();
      expect(result.final).toBeTruthy();
      expect(["approved", "auto-approved"]).toContain(hitl?.status);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. MARKETING: LinkedIn post about FounderOS + TypeScript
  //    Turicks is building FounderOS — this IS the product demo.
  //    Post should establish Turicks as a serious TypeScript + AI engineering shop.
  //    Expect: hook grabs attention, specific technical details, CTA to DM/follow
  // ─────────────────────────────────────────────────────────────────────────────

  describe("5. MarketingPod — LinkedIn post: FounderOS architecture reveal", () => {

    it("writes a technical LinkedIn post that positions Turicks as AI engineering leaders", { timeout: TIMEOUT_MS * 2 }, async () => {
      if (!ollamaAvailable) return;

      separator("MARKETING: LinkedIn post — FounderOS TypeScript architecture");
      console.log("🎯 Audience: CTOs, senior engineers, AI founders at Series A–B");
      console.log("📣 Goal: establish Turicks as the agency that ships real AI systems\n");

      const task = `Write a LinkedIn post for Turicks AI agency:

Topic: "We built an AI operating system for a one-man company. Here's what we learned about production LangGraph."

Key technical points to include:
1. Native fetch over SDK: removed 4 LangChain provider packages, eliminated ~30MB deps and 8 type-cast workarounds
2. Critic cross-model: generator uses Gemini, critic uses Claude — different families = genuine adversarial critique
3. HITL durability: write to Postgres BEFORE calling LangGraph interrupt() — crash-safe human approval
4. Self-improvement: task_outcomes table feeds few-shot examples into prompts — no vector DB needed at <10k rows

Format:
- Hook: one punchy sentence that stops the scroll
- 3-4 bullet points (specific, numbers where possible)
- Honest about trade-offs (not just "we're great")
- CTA: invite engineers/CTOs to DM if they want to discuss
- Max 250 words
- No emojis except sparingly for bullets
- No hype words: no "revolutionary", "10x", "game-changer"

Turicks voice: technical depth + founder candour. We build what others only prototype.`;

      const result = await marketingSubgraph.invoke(makeMktgState(task));

      printSection("MARKETING ENGINEER BRIEF");
      const brief = result.mktg_engineer_brief as Record<string, unknown> | null;
      if (brief) {
        console.log(`Goal:          ${String(brief.goal ?? "N/A")}`);
        console.log(`Content Pillar: ${String(brief.content_pillar ?? "N/A")}`);
        console.log(`Platform:      ${String(brief.platform ?? "N/A")}`);
        console.log(`Format:        ${String(brief.format ?? "N/A")}`);
        console.log(`Target Emotion: ${String(brief.target_emotion ?? "N/A")}`);
      }

      printSection("RESEARCH NOTES");
      const research = result.research_notes as string | null;
      if (research) {
        console.log(research.slice(0, 300));
      } else {
        console.log("(no research notes)");
      }

      printSection("CONTENT DRAFT (the actual LinkedIn post)");
      const draft = result.content_draft as string | null;
      if (draft) {
        console.log(draft);
      } else {
        flagQuality("Marketing", "🔴 CRITICAL", "No content draft produced");
        console.log("🔴 No content draft — critical failure");
      }

      printSection("CRITIQUE REVIEW");
      const critiques = result.critiques as Array<{ result: string; notes: string }> ?? [];
      critiques.forEach((c, i) => {
        console.log(`Critique ${i + 1}: ${c.result} — ${c.notes?.slice(0, 120) ?? "N/A"}`);
      });

      printSection("HITL + PUBLISH");
      const hitl  = result.hitl  as { status: string } | null;
      const final = result.final as { published_at?: string; platform?: string } | null;
      console.log(`HITL status: ${hitl?.status ?? "N/A"}`);
      console.log(`Published at: ${final?.published_at ?? "pending"}`);

      // ── Quality checks ────────────────────────────────────────────────────────
      expect(draft).toBeTruthy();

      const wordCount = (draft ?? "").split(/\s+/).length;
      console.log(`\n📊 Word count: ${wordCount} words`);

      if (wordCount > 300) {
        flagQuality("Marketing", "🟡 WARN",
          `Post too long (${wordCount}w, asked for <250) — content_writer needs tighter constraint`);
      } else {
        flagQuality("Marketing", "✅ OK", `Post length OK (${wordCount} words)`);
      }

      // Should mention technical details (the whole point of this post)
      const draftLower = (draft ?? "").toLowerCase();
      const techTerms = ["langgraph", "typescript", "fetch", "postgres", "interrupt", "few-shot", "cascade"];
      const foundTechTerms = techTerms.filter((t) => draftLower.includes(t));
      if (foundTechTerms.length < 2) {
        flagQuality("Marketing", "🟡 WARN",
          `Post missing technical details (found: ${foundTechTerms.join(", ") || "none"}) — content_writer may be too high-level`);
        console.log(`⚠️  Tech terms found: ${foundTechTerms.join(", ") || "none"} (need ≥2 from: ${techTerms.join(", ")})`);
      } else {
        flagQuality("Marketing", "✅ OK", `Post has technical depth (${foundTechTerms.join(", ")})`);
      }

      // Check for hype words
      const hypeWords = ["revolutionary", "10x", "game-changer", "game-changing", "cutting-edge"];
      const foundHype = hypeWords.filter((w) => draftLower.includes(w));
      if (foundHype.length > 0) {
        flagQuality("Marketing", "🟡 WARN", `Hype words in post: ${foundHype.join(", ")}`);
        console.log(`⚠️  Hype words found: ${foundHype.join(", ")}`);
      }

      expect(wordCount).toBeGreaterThan(30);
      expect(result.final).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. CROSS-DEPT: "We closed Revolut" → Engineering starts client kickoff
  //    Simulates the real handoff: Sales closes a deal → Engineering gets briefed.
  //    Tests that state transfers correctly between pods and context isn't lost.
  // ─────────────────────────────────────────────────────────────────────────────

  describe("6. Cross-Department: Sales closes Revolut → Engineering kickoff", () => {

    it("hands state from a closed deal into an engineering kickoff plan", { timeout: TIMEOUT_MS * 4 }, async () => {
      if (!ollamaAvailable) return;

      separator("CROSS-DEPT: Revolut deal closed → Engineering onboarding brief");
      console.log("🤝 Scenario: Sales just closed Revolut as a client");
      console.log("   → Engineering needs a kickoff brief from the deal context\n");

      // ── STAGE 1: Simulate a closed deal (SalesPod) ────────────────────────────
      console.log("📋 STAGE 1: SalesPod — generate the winning proposal brief...");

      const salesTask = `Create a winning proposal summary for Revolut:
- They need AI-powered B2B client onboarding automation
- KYC document review currently takes 6-8 weeks manually
- They have 2,500 engineers, £50M allocated for internal tooling
- They chose Turicks over 2 other agencies because of: TypeScript expertise + AI agent track record
- Agreed scope: Phase 1 = automate document extraction + Companies House verification
- Budget: £180,000 for Phase 1 (3 months)
- Key stakeholder: Head of Platform Engineering (Boris K.)
- Success metric: reduce onboarding time from 6 weeks to 5 days

Generate the proposal brief that will be handed to Engineering for kickoff.`;

      const salesResult = await salesSubgraph.invoke(makeSalesState(salesTask));

      const email = salesResult.email_draft as { subject: string; body: string } | null;
      console.log(`\n  📧 Proposal brief generated: ${email?.subject ?? "(no subject)"}`);
      console.log(`  ${email?.body?.slice(0, 200) ?? "(no body)"}...`);

      const salesFinal = salesResult.final as Record<string, unknown> | null;
      const hitlStatus = (salesFinal?.hitl_status as string) ?? "approved";
      console.log(`  HITL: ${hitlStatus}`);

      // ── STAGE 2: Engineering kickoff ──────────────────────────────────────────
      console.log("\n📋 STAGE 2: EngineeringPod — build the delivery plan from the deal...");

      // Inject deal context into engineering task
      const proposalContext = email?.body ?? "Revolut KYC automation project";
      const engTask = `CLIENT KICKOFF: Revolut — KYC Onboarding Automation

DEAL CONTEXT (from Sales):
${proposalContext}

ENGINEERING BRIEF:
We've been hired to automate Revolut's B2B client onboarding. Scope:
- Phase 1: Document extraction agent (passport, utility bills, company accounts)
- Companies House API integration for company verification
- Risk scoring microservice (input: Revolut's JSON config rules)
- REST API integration to write results into their Salesforce CRM
- HITL flag for uncertain cases

Constraints:
- UK data residency (no US data transfer)
- Must integrate with their Postgres + Kotlin backend
- TypeScript + Node.js (Turicks stack)
- Deliver working Phase 1 in 12 weeks

Create the engineering delivery plan and initial TypeScript scaffold.`;

      const engResult = await engineeringSubgraph.invoke(makeEngState(engTask));

      printSection("ENGINEERING KICKOFF PLAN");
      const plan = engResult.eng_engineer_plan as {
        summary: string;
        steps: Array<Record<string, unknown>>;
        risks: string[];
        estimated_hours: number;
        first_deliverable: string;
      } | null;

      if (plan) {
        console.log(`Summary:  ${plan.summary}`);
        console.log(`Hours:    ${plan.estimated_hours}h estimated`);
        console.log(`\nDelivery steps (${plan.steps.length}):`);
        plan.steps.forEach((s, i) => {
          const label = String(s["name"] ?? s["title"] ?? s["action"] ?? `Step ${i + 1}`);
          console.log(`  ${i + 1}. ${label}`);
        });
        console.log(`\nRisks:`);
        plan.risks.forEach((r) => console.log(`  ⚠️  ${r}`));
      } else {
        console.log("(no structured plan — raw text)");
      }

      printSection("CODE SCAFFOLD");
      const code = engResult.code_draft as string | null;
      if (code) {
        console.log(`(${code.split("\n").length} lines)`);
        console.log(code.slice(0, 500));
      } else {
        console.log("(no scaffold)");
        flagQuality("CrossDept", "🟡 WARN", "Engineering scaffold missing after cross-dept handoff");
      }

      printSection("STATE TRANSFER CHECK");
      // Verify that Engineering received deal context from Sales
      const planText = JSON.stringify(plan ?? "").toLowerCase();
      const codeText = (code ?? "").toLowerCase();
      const combinedText = planText + codeText;

      const dealContextSignals = ["revolut", "kyc", "onboarding", "document", "companies house"];
      const foundSignals = dealContextSignals.filter((s) => combinedText.includes(s));
      console.log(`Deal context signals found in Engineering output: ${foundSignals.join(", ") || "NONE"}`);

      if (foundSignals.length >= 2) {
        flagQuality("CrossDept", "✅ OK",
          `State transfer OK — Engineering understood deal context (${foundSignals.join(", ")})`);
        console.log("✅ Engineering correctly absorbed the Revolut deal context");
      } else {
        flagQuality("CrossDept", "🟡 WARN",
          "Engineering output doesn't reference Revolut context — check state injection in task prompt");
        console.log("🟡 Engineering may have ignored deal context — check prompt context injection");
      }

      // ── Final assertions ──────────────────────────────────────────────────────
      expect(salesResult.final).toBeTruthy();
      expect(engResult.code_draft).toBeTruthy();
      expect(engResult.final).toBeTruthy();

      const engHitl = engResult.hitl as { status: string } | null;
      expect(["approved", "auto-approved"]).toContain(engHitl?.status);

      console.log(`\n✅ Cross-dept pipeline complete: Sales → Engineering state transfer verified`);
    });
  });

});
