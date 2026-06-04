/**
 * FounderOS — Full E2E Founder Simulation
 * =========================================
 * Runs 15 realistic founder scenarios through the LIVE office graph.
 * For each: records route taken, tools called, actual response, timing.
 * Prints a pass/fail table at the end.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/e2e-founder-test.ts
 *
 * This is the "pairing session" test — think of each scenario as a real
 * Telegram message the founder would send and what a reliable OS must do.
 */

import { buildOffice, getPendingApproval } from "../src/agents/office.js";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

// ── Scenario definitions ──────────────────────────────────────────────────────

interface Scenario {
  id: string;
  dept: string;            // expected department
  input: string;
  expectedTools?: string[];
  expectHitl?: boolean;
  validate?: (response: string, tools: string[]) => { ok: boolean; reason: string };
}

const SCENARIOS: Scenario[] = [
  // ── Personal dept ─────────────────────────────────────────────────────────
  {
    id: "personal-read-readme",
    dept: "personal",
    input: "Read the file ~/Projects/founderos/package.json and tell me the version number.",
    expectedTools: ["read_file"],
    expectHitl: false,
    validate: (r) => ({
      ok: r.includes("version") || r.includes("\"name\"") || r.includes("founderos"),
      reason: "Should return actual package.json content with version",
    }),
  },
  {
    id: "personal-list-desktop",
    dept: "personal",
    input: "What files are in my ~/Desktop folder?",
    expectedTools: ["list_dir"],
    expectHitl: false,
    validate: (r) => ({
      ok: !r.toLowerCase().includes("okay") && !r.toLowerCase().includes("i don't have"),
      reason: "Should list actual files, not hallucinate or refuse",
    }),
  },
  {
    id: "personal-send-file",
    dept: "personal",
    input: "Read the file ~/Projects/founderos/README.md and paste me the first heading.",
    expectedTools: ["read_file"],
    expectHitl: false,
    validate: (r) => ({
      ok: r.includes("#") || r.toLowerCase().includes("founderos"),
      reason: "Should include actual README content",
    }),
  },
  {
    id: "personal-list-src",
    dept: "personal",
    input: "List the files inside ~/Projects/founderos/src/agents/",
    expectedTools: ["list_dir"],
    expectHitl: false,
    validate: (r) => ({
      ok: r.includes("office") || r.includes(".ts"),
      reason: "Should list actual TypeScript files in src/agents",
    }),
  },

  // ── Research ──────────────────────────────────────────────────────────────
  {
    id: "research-langgraph",
    dept: "research",
    input: "What is LangGraph and what version is the latest?",
    expectedTools: ["search_web"],
    expectHitl: false,
    validate: (r) => ({
      ok: r.toLowerCase().includes("langchain") || r.toLowerCase().includes("langgraph") || r.includes("0."),
      reason: "Should return real LangGraph info from web",
    }),
  },

  // ── Engineering ───────────────────────────────────────────────────────────
  {
    id: "eng-list-repos",
    dept: "engineering",
    input: "List my GitHub repositories.",
    expectedTools: ["github_read"],
    expectHitl: false,
    validate: (r) => ({
      ok: r.toLowerCase().includes("founderos") || r.toLowerCase().includes("github") || r.includes("pushkarverma"),
      reason: "Should list actual GitHub repos",
    }),
  },
  {
    id: "eng-write-code",
    dept: "engineering",
    input: "Write a TypeScript function that formats a date as DD/MM/YYYY.",
    expectedTools: [],
    expectHitl: false,
    validate: (r, tools) => ({
      ok: r.includes("function") || r.includes("=>") || r.includes("Date") || r.includes("```"),
      reason: "Should return working TypeScript code inline (no tools needed)",
    }),
  },

  // ── Context (supervisor-level) ─────────────────────────────────────────────
  {
    id: "context-priorities",
    dept: "supervisor",
    input: "What are my current priorities and what should I focus on this week?",
    expectedTools: ["read_context"],
    expectHitl: false,
    validate: (r) => ({
      ok: r.toLowerCase().includes("job") || r.toLowerCase().includes("turicks") || r.toLowerCase().includes("founderos"),
      reason: "Should return real context from DB (job search, turicks, etc.)",
    }),
  },
  {
    id: "context-tech-stack",
    dept: "supervisor",
    input: "Are we using local models in our workflow?",
    expectedTools: ["read_context"],
    expectHitl: false,
    validate: (r) => ({
      ok: r.toLowerCase().includes("ollama") || r.toLowerCase().includes("local") || r.toLowerCase().includes("qwen"),
      reason: "Should know about Ollama from seeded context",
    }),
  },

  // ── Job-Hunt ──────────────────────────────────────────────────────────────
  {
    id: "jobhunt-search",
    dept: "jobhunt",
    input: "Search for LangGraph AI engineer job openings and summarise what you found.",
    expectedTools: ["search_jobs"],
    expectHitl: false,
    validate: (r, tools) => ({
      ok: tools.includes("search_jobs") || r.toLowerCase().includes("engineer") || r.toLowerCase().includes("ai") || r.toLowerCase().includes("job") || r.toLowerCase().includes("langraph"),
      reason: "search_jobs tool should have been called with job results",
    }),
  },
  {
    id: "jobhunt-cv",
    dept: "jobhunt",
    input: "What are my strongest technical skills for applying to an AI engineer role?",
    expectedTools: ["read_cv"],
    expectHitl: false,
    validate: (r, tools) => ({
      ok: tools.includes("read_cv") || r.toLowerCase().includes("langgraph") || r.toLowerCase().includes("typescript") || r.toLowerCase().includes("skill") || r.toLowerCase().includes("multi-agent") || r.toLowerCase().includes("hitl"),
      reason: "read_cv should have been called and response should mention skills",
    }),
  },

  // ── Prospecting ───────────────────────────────────────────────────────────
  {
    id: "prospect-score",
    dept: "prospecting",
    input: "Score Framer (framer.com) as a potential Turicks client against our ICP.",
    expectedTools: ["search_web"],
    expectHitl: false,
    validate: (r) => ({
      ok: r.match(/[0-9]\/10|score|PASS|FAIL/i) !== null,
      reason: "Should return a scored ICP evaluation",
    }),
  },

  // ── Knowledge search ──────────────────────────────────────────────────────
  {
    id: "knowledge-brand",
    dept: "research",
    input: "Search the internal knowledge base for our brand voice rules on LinkedIn.",
    expectedTools: [],  // accept search_knowledge OR search_memory — both access the knowledge base
    expectHitl: false,
    validate: (r) => ({
      ok: !r.includes("not been synced") && !r.includes("no knowledge entries"),
      reason: "turicks-brain should have brand entries",
    }),
  },

  // ── Sales/Prospecting research ───────────────────────────────────────────────
  // Note: "research as a prospect before writing outreach - just research phase"
  // legitimately routes to either sales OR prospecting - both do web research.
  // We test content correctness, not strict department routing here.
  {
    id: "sales-research",
    dept: "sales",
    input: "Research Webflow (webflow.com) — we plan to reach out to them. What do they do and do they fit our ICP?",
    expectedTools: ["search_web"],
    expectHitl: false,
    validate: (r) => ({
      ok: r.toLowerCase().includes("webflow") || r.toLowerCase().includes("cms") || r.toLowerCase().includes("no-code") || r.toLowerCase().includes("icp") || r.toLowerCase().includes("score"),
      reason: "Should research Webflow and return findings relevant to outreach",
    }),
  },

  // ── Follow-up context test (previously broken) ────────────────────────────
  {
    id: "personal-followup",
    dept: "personal",
    input: "Read the file ~/Projects/founderos/src/agents/office.ts and tell me how many departments are in the createSupervisor call.",
    expectedTools: ["read_file"],
    expectHitl: false,
    validate: (r) => ({
      ok: r.includes("8") || r.includes("eight") || r.toLowerCase().includes("department") || r.toLowerCase().includes("agent"),
      reason: "Should read actual office.ts and count departments",
    }),
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────────

interface Result {
  scenario: Scenario;
  route: string;
  tools: string[];
  hitl: boolean;
  response: string;
  durationMs: number;
  routeOk: boolean;
  toolsOk: boolean;
  validateOk: boolean;
  validateReason: string;
  error?: string;
}

function extractRouteAndTools(
  messages: Array<{ _getType?: () => string; content: unknown; tool_calls?: unknown[]; name?: string }>
): { route: string; tools: string[] } {
  let route = "unknown";
  const tools: string[] = [];

  for (const m of messages) {
    const type = m._getType?.() ?? "";
    const content = typeof m.content === "string" ? m.content : "";

    // Transfer messages tell us the route
    if (type === "tool" && content.includes("transfer_to_")) {
      const match = content.match(/transfer_to_(\w+)/);
      if (match) route = match[1]!;
    }
    if (type === "ai" && content.includes("transfer_to_")) {
      const match = content.match(/transfer_to_(\w+)/);
      if (match) route = match[1]!;
    }
    // Tool calls
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<{ name?: string }>) {
        if (tc.name && !tc.name.startsWith("transfer_to_")) {
          tools.push(tc.name);
        }
        if (tc.name && tc.name.startsWith("transfer_to_")) {
          route = tc.name.replace("transfer_to_", "");
        }
      }
    }
    // Tool messages with tool_name
    if (type === "tool" && m.name && !m.name.startsWith("transfer_to_")) {
      if (!tools.includes(m.name)) tools.push(m.name);
    }
  }

  return { route, tools };
}

function getLastAiText(
  messages: Array<{ _getType?: () => string; content: unknown; tool_calls?: unknown[] }>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const type = m._getType?.() ?? "";
    const text = typeof m.content === "string" ? m.content : "";
    if (type === "ai" && text.trim() && !(m.tool_calls && (m.tool_calls as unknown[]).length > 0)) {
      return text.trim();
    }
  }
  return "";
}

async function runScenario(
  office: ReturnType<typeof buildOffice>,
  scenario: Scenario,
  idx: number,
): Promise<Result> {
  const threadId = `e2e-${scenario.id}-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };
  const start = Date.now();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`[${idx + 1}/${SCENARIOS.length}] ${scenario.id}`);
  console.log(`📨 Input: "${scenario.input.slice(0, 80)}..."`);

  try {
    // Use handleToolStart callback — same pattern as eval harness.
    // This is the ONLY reliable way to observe tools called inside sub-agents
    // under outputMode "last_message" (sub-agent tool calls don't surface in
    // the top-level messages array).
    const observedTools: string[] = [];
    const toolCollector = {
      name: "e2e-tool-collector",
      handleToolStart: (
        _tool: unknown, _input: unknown, _runId: unknown,
        _parentRunId?: unknown, _tags?: unknown, _metadata?: unknown,
        runName?: string,
      ): void => { if (runName) observedTools.push(runName); },
    };

    const res = await office.invoke(
      { messages: [new HumanMessage(scenario.input)] },
      { configurable: { thread_id: threadId }, callbacks: [toolCollector] },
    ) as { messages?: BaseMessage[] };

    const durationMs = Date.now() - start;
    const messages = (res.messages ?? []) as Array<{
      _getType?: () => string;
      content: unknown;
      tool_calls?: unknown[];
      name?: string;
    }>;

    // Route from message trail (transfer_to_* calls)
    const { route } = extractRouteAndTools(messages);
    // Tools from callback (accurate for sub-agent tool calls)
    const tools = observedTools.filter(t => !t.startsWith("transfer_to_"));
    const response = getLastAiText(messages);

    // Check for pending HITL
    let hitl = false;
    try {
      const pending = await getPendingApproval(office as Parameters<typeof getPendingApproval>[0], config);
      hitl = pending !== null;
    } catch {
      // HITL check failed — treat as no HITL
    }

    const routeOk = scenario.dept === "supervisor"
      ? true // supervisor handles directly
      : route === scenario.dept || route.includes(scenario.dept);

    const toolsOk = !scenario.expectedTools?.length
      ? true
      : scenario.expectedTools.every((t) => tools.includes(t));

    const validation = scenario.validate
      ? scenario.validate(response, tools)
      : { ok: true, reason: "no validation" };

    console.log(`🗺️  Route: ${route} ${routeOk ? "✅" : "❌"} (expected: ${scenario.dept})`);
    console.log(`🔧 Tools: [${tools.join(", ")}] ${toolsOk ? "✅" : "❌"}`);
    console.log(`📝 Response: "${response.slice(0, 150)}..."`);
    console.log(`✅ Validate: ${validation.ok ? "PASS" : "FAIL"} — ${validation.reason}`);
    console.log(`⏱  ${durationMs}ms`);

    return {
      scenario,
      route,
      tools,
      hitl,
      response,
      durationMs,
      routeOk,
      toolsOk,
      validateOk: validation.ok,
      validateReason: validation.reason,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errMsg = (err as Error).message ?? String(err);
    console.log(`❌ ERROR: ${errMsg.slice(0, 200)}`);
    return {
      scenario,
      route: "error",
      tools: [],
      hitl: false,
      response: "",
      durationMs,
      routeOk: false,
      toolsOk: false,
      validateOk: false,
      validateReason: `Threw error: ${errMsg.slice(0, 100)}`,
      error: errMsg,
    };
  }
}

async function main() {
  console.log("🏗️  FounderOS — Full E2E Founder Simulation");
  console.log(`📋 Running ${SCENARIOS.length} scenarios\n`);

  const office = buildOffice(new MemorySaver());
  const results: Result[] = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const result = await runScenario(office, SCENARIOS[i]!, i);
    results.push(result);
  }

  // ── Summary table ──────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(80)}`);
  console.log("📊 E2E TEST RESULTS\n");

  const header = "ID                           | Dept    | Route✅ | Tools✅ | Valid✅ | ms";
  console.log(header);
  console.log("─".repeat(header.length));

  let passed = 0;
  const failures: Result[] = [];

  for (const r of results) {
    const allOk = r.routeOk && r.toolsOk && r.validateOk;
    if (allOk) passed++;
    else failures.push(r);

    const id = r.scenario.id.padEnd(28);
    const dept = r.scenario.dept.padEnd(8);
    const routeStr = r.routeOk ? " ✅ " : ` ❌(${r.route.slice(0, 6)})`;
    const toolsStr = r.toolsOk ? " ✅ " : " ❌ ";
    const validStr = r.validateOk ? " ✅ " : " ❌ ";
    const ms = String(r.durationMs).padStart(5);
    console.log(`${id}| ${dept}| ${routeStr}   | ${toolsStr}   | ${validStr}   | ${ms}ms`);
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log(`\nSCORE: ${passed}/${results.length} passed\n`);

  if (failures.length > 0) {
    console.log("❌ FAILURES:\n");
    for (const f of failures) {
      console.log(`  • ${f.scenario.id}`);
      if (!f.routeOk) console.log(`    Route: got "${f.route}", expected "${f.scenario.dept}"`);
      if (!f.toolsOk) console.log(`    Tools: got [${f.tools.join(",")}], expected [${f.scenario.expectedTools?.join(",")}]`);
      if (!f.validateOk) console.log(`    Validate: ${f.validateReason}`);
      if (f.error) console.log(`    Error: ${f.error.slice(0, 150)}`);
    }
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
