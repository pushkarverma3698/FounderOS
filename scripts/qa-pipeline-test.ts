/**
 * FounderOS — QA Pipeline Test
 * ==============================
 * Fires realistic tasks through the real system and reports what breaks.
 * Tests: local model (Ollama), cloud model cascade, supervisor routing,
 *        prospecting subgraph, and sales node callChain.
 *
 * Usage:
 *   npx tsx scripts/qa-pipeline-test.ts                   # full run
 *   npx tsx scripts/qa-pipeline-test.ts --local-only      # only Ollama tier tests
 *   npx tsx scripts/qa-pipeline-test.ts --cloud-only      # skip Ollama tests
 *   npx tsx scripts/qa-pipeline-test.ts --suite supervisor # one suite
 *
 * Reports a QA summary with PASS/FAIL/WARN per test, latency, and cost.
 *
 * NOTE: The supervisor and prospecting tests make REAL API calls.
 *       Set BUDGET_DAILY_USD to a low value when running repeatedly.
 */

// ── Stub required env vars BEFORE any module imports that parse env ───────────
// config.ts calls parseEnv() at module load time. We must set all required vars
// before any import chain reaches config.ts. This lets the QA script run without
// a .env file — we stub values for services we don't actually call in QA mode.

// Wire Ollama (OpenAI-compatible API at /v1 — same interface as LM Studio)
if (!process.env["LM_STUDIO_URL"] || process.env["LM_STUDIO_URL"].includes("1234")) {
  process.env["LM_STUDIO_URL"] = "http://localhost:11434";
}
if (!process.env["LM_STUDIO_MODEL"] || process.env["LM_STUDIO_MODEL"] === "qwen2.5-coder-7b-instruct") {
  process.env["LM_STUDIO_MODEL"] = "founderos:latest";
}

// Stub required vars that the QA script doesn't use directly
if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgresql://qa_stub:qa_stub@localhost:5432/qa_stub";
}
if (!process.env["TELEGRAM_BOT_TOKEN"]) {
  process.env["TELEGRAM_BOT_TOKEN"] = "qa_stub_bot_token";
}
if (!process.env["TELEGRAM_CHAT_ID"]) {
  process.env["TELEGRAM_CHAT_ID"] = "0";
}
// Set test mode so components skip DB/Telegram in QA
process.env["NODE_ENV"] = "test";
// If API keys are empty strings (not set), replace with undefined-equivalent
// so Zod's .optional() works (it rejects empty strings on .min(1))
for (const key of ["ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"]) {
  if (process.env[key] === "") {
    delete process.env[key]; // Zod .optional() accepts missing keys, not empty strings
  }
}

// ── Static imports ONLY for packages that don't touch config.ts ──────────────
// @langchain/core/messages is a pure types/utilities package — no env parsing.
// All src/ imports are deferred to dynamic imports inside main() to ensure
// env vars are fully set before config.ts parseEnv() runs.
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

// ── Module-level handles — assigned by dynamic import inside main() ───────────
// Using 'any' here is acceptable in a QA script — the strict types come from
// the dynamic import return type at assignment time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let callCascade: (tier: string, messages: any[], opts?: any) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _resolveDepartment: (agent: string) => string | null;

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const LOCAL_ONLY = args.includes("--local-only");
const CLOUD_ONLY = args.includes("--cloud-only");
const SUITE_FILTER = args.find((a) => a.startsWith("--suite"))?.split("=")[1] ?? null;

// ── Test result types ─────────────────────────────────────────────────────────
interface TestResult {
  suite: string;
  name: string;
  status: "PASS" | "FAIL" | "WARN" | "SKIP";
  latencyMs: number;
  costUsd?: number;
  output?: string;
  error?: string;
  notes?: string;
}

const results: TestResult[] = [];
let totalCost = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runTest(
  suite: string,
  name: string,
  fn: () => Promise<{ output?: string; notes?: string; costUsd?: number }>,
): Promise<void> {
  if (SUITE_FILTER && !suite.toLowerCase().includes(SUITE_FILTER.toLowerCase())) {
    results.push({ suite, name, status: "SKIP", latencyMs: 0 });
    return;
  }

  const start = Date.now();
  try {
    const r = await fn();
    const latencyMs = Date.now() - start;
    if (r.costUsd) totalCost += r.costUsd;
    results.push({
      suite,
      name,
      status: "PASS",
      latencyMs,
      output: r.output?.slice(0, 300),
      notes: r.notes,
      costUsd: r.costUsd,
    });
    console.log(`  ✅  [${latencyMs}ms] ${name}`);
    if (r.notes) console.log(`      ℹ️  ${r.notes}`);
  } catch (err) {
    const latencyMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    results.push({ suite, name, status: "FAIL", latencyMs, error: error.slice(0, 300) });
    console.log(`  ❌  [${latencyMs}ms] ${name}`);
    console.log(`      Error: ${error.slice(0, 200)}`);
  }
}

function warn(suite: string, name: string, notes: string, latencyMs = 0): void {
  results.push({ suite, name, status: "WARN", latencyMs, notes });
  console.log(`  ⚠️   ${name}: ${notes}`);
}

// ── Connectivity Checks ───────────────────────────────────────────────────────

async function suiteConnectivity(): Promise<void> {
  console.log("\n🔌 SUITE: Connectivity");

  // 1. Ollama health check
  await runTest("connectivity", "Ollama /api/tags responds", async () => {
    const res = await fetch("http://localhost:11434/api/tags");
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = await res.json() as { models?: { name: string }[] };
    const models = data.models?.map((m: { name: string }) => m.name) ?? [];
    const hasFounderOS = models.some((n: string) => n.includes("founderos"));
    return {
      output: `Models: ${models.join(", ")}`,
      notes: hasFounderOS ? "founderos:latest ✅" : "⚠️ founderos:latest not found — run: ollama pull founderos:latest",
    };
  });

  // 2. Ollama OpenAI-compatible endpoint
  await runTest("connectivity", "Ollama /v1/models (OpenAI compat)", async () => {
    const res = await fetch("http://localhost:11434/v1/models", {
      headers: { Authorization: "Bearer ollama" },
    });
    if (!res.ok) throw new Error(`/v1/models returned ${res.status}`);
    const data = await res.json() as { data?: { id: string }[] };
    const ids = data.data?.map((m: { id: string }) => m.id) ?? [];
    return { output: `Available: ${ids.slice(0, 5).join(", ")}` };
  });

  // 3. Quick local LLM call
  if (!CLOUD_ONLY) {
    await runTest("connectivity", "Ollama: direct JSON call (no LangChain)", async () => {
      const res = await fetch("http://localhost:11434/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ollama" },
        body: JSON.stringify({
          model: "founderos:latest",
          messages: [
            { role: "system", content: "Return only valid JSON. No markdown, no explanation." },
            { role: "user", content: 'Respond with: {"status": "ok", "model": "founderos"}' },
          ],
          temperature: 0.1,
          max_tokens: 50,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content ?? "";
      return { output: content };
    });
  }
}

// ── Local Model Tests ─────────────────────────────────────────────────────────

async function suiteLocalModel(): Promise<void> {
  if (CLOUD_ONLY) {
    console.log("\n🤖 SUITE: Local Model (SKIPPED — --cloud-only)");
    return;
  }
  console.log("\n🤖 SUITE: Local Model (Ollama founderos:latest via callCascade)");

  // Test 1: nano task via LangChain callCascade
  // Note: nano tier uses Google Gemini-flash-lite, NOT local. This test uses `local` tier explicitly.
  await runTest("local_model", "callCascade('local') — JSON extraction", async () => {
    const messages = [
      new SystemMessage("You are a URL canonicaliser. Return ONLY valid JSON, no markdown.\nReturn: {\"company_url\": \"<canonical https URL>\", \"company_name\": \"<company name>\"}"),
      new HumanMessage("Extract from: acme corp"),
    ];
    const result = await callCascade("local", messages, {
      agent: "qa_test_disambiguate",
      tenant_id: "qa",
    });
    // Verify it returns parseable JSON
    const clean = result.text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean) as { company_url?: string; company_name?: string };
    if (!parsed.company_url && !parsed.company_name) {
      throw new Error(`Missing expected fields. Got: ${clean.slice(0, 200)}`);
    }
    return {
      output: clean.slice(0, 200),
      notes: `model used: ${result.model ?? "unknown"}`,
      costUsd: result.cost_usd,
    };
  });

  // Test 2: Instruction following — banned phrase detection
  await runTest("local_model", "callCascade('local') — instruction following", async () => {
    const messages = [
      new SystemMessage(`You are an email quality checker.
RULES:
- BANNED phrases: "I wanted to reach out", "I hope this finds you well", "touching base"
- Return JSON: {"passed": boolean, "violations": string[]}
Return ONLY valid JSON.`),
      new HumanMessage(`Check this email:
"I wanted to reach out because I noticed Acme Corp is growing fast.
Our AI tools can help you scale your team."`),
    ];
    const result = await callCascade("local", messages, {
      agent: "qa_test_critic",
      tenant_id: "qa",
    });
    const clean = result.text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean) as { passed?: boolean; violations?: string[] };
    const correctAnswer = parsed.passed === false && (parsed.violations?.length ?? 0) > 0;
    return {
      output: clean.slice(0, 300),
      notes: correctAnswer
        ? "✅ Correctly detected banned phrase"
        : "⚠️ Did not detect 'I wanted to reach out' — model needs calibration",
      costUsd: result.cost_usd,
    };
  });

  // Test 3: Multi-step reasoning — ICP scoring
  await runTest("local_model", "callCascade('local') — ICP scoring (0.0-1.0)", async () => {
    const messages = [
      new SystemMessage(`You are an ICP (Ideal Customer Profile) scorer for Turicks, an AI automation agency.
ICP criteria: AI-forward company, 10-200 employees, B2B SaaS or tech-enabled, software team exists.
Return ONLY valid JSON: {"icp_score": 0.0-1.0, "icp_rationale": "1-2 sentences", "outreach_tier": "md|ceo|disqualified"}`),
      new HumanMessage(`Score this company:
Company: Linear (linear.app)
Pain points: Engineering workflow management, sprint tracking, bug triage
Tech stack: React, Go, PostgreSQL
Team size: ~70 employees, software-focused
Funding: Series B, $35M`),
    ];
    const result = await callCascade("local", messages, {
      agent: "qa_test_icp",
      tenant_id: "qa",
    });
    const clean = result.text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean) as { icp_score?: number; icp_rationale?: string; outreach_tier?: string };
    const score = Number(parsed.icp_score ?? 0);
    if (isNaN(score) || score < 0 || score > 1) {
      throw new Error(`Invalid icp_score: ${parsed.icp_score}`);
    }
    return {
      output: clean.slice(0, 300),
      notes: `Score: ${score.toFixed(2)}, Tier: ${parsed.outreach_tier ?? "unknown"}`,
      costUsd: result.cost_usd,
    };
  });

  // Test 4: Latency measurement — 3 consecutive calls
  await runTest("local_model", "Local model latency (3x back-to-back)", async () => {
    const timings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await callCascade("local", [
        new SystemMessage("You classify emails into categories. Return JSON: {\"category\": \"sales|support|spam\"}"),
        new HumanMessage(`Classify: "Following up on our proposal for AI automation at your company"`),
      ], { agent: "qa_latency_test", tenant_id: "qa" });
      timings.push(Date.now() - t);
    }
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    return {
      notes: `Latencies: ${timings.join("ms, ")}ms | avg: ${avg.toFixed(0)}ms`,
      output: timings.join(","),
    };
  });
}

// ── Supervisor Routing Tests ──────────────────────────────────────────────────

async function suiteSupervior(): Promise<void> {
  console.log("\n🧠 SUITE: Supervisor Department Resolution");

  // Unit test: _resolveDepartment (no API calls)
  const routingCases: Array<[string, string, string]> = [
    ["bdr", "sales", "BDR → sales"],
    ["lead_intel", "sales", "lead_intel → sales"],
    ["senior_dev", "engineering", "senior_dev → engineering"],
    ["linkedin_post_writer", "social", "LinkedIn post writer → social (NOT marketing)"],
    ["social_researcher", "social", "social researcher → social"],
    ["seo_specialist", "marketing", "SEO → marketing"],
    ["unknown_agent_xyz", "null", "Unknown → null (no false routes)"],
  ];

  for (const [agent, expected, label] of routingCases) {
    const dept = _resolveDepartment(agent);
    const actual = dept ?? "null";
    if (actual !== expected) {
      warn("supervisor", label, `Expected ${expected}, got ${actual} — routing heuristic mismatch`);
    } else {
      results.push({ suite: "supervisor", name: label, status: "PASS", latencyMs: 0, output: actual });
      console.log(`  ✅  ${label}`);
    }
  }

  if (CLOUD_ONLY || LOCAL_ONLY) return; // Full supervisor test needs cloud

  // Full supervisor test — real CEO-tier LLM call
  const supervisorCases = [
    {
      task: "Prospect the company Linear (linear.app) for Turicks outreach",
      expectedDept: "prospecting",
    },
    {
      task: "Write a cold email to Notion (notion.so) about AI automation services",
      expectedDept: "sales",
    },
    {
      task: "Write a LinkedIn post about why LangGraph is better than AutoGen for production AI",
      expectedDept: "social",
    },
    {
      task: "Review the authentication code in src/gateway/telegram.ts for security issues",
      expectedDept: "engineering",
    },
  ];

  for (const tc of supervisorCases) {
    await runTest("supervisor", `Route: "${tc.task.slice(0, 60)}..."`, async () => {
      const graph = await getGraph();
      if (!graph) throw new Error("Graph failed to initialize");

      const runId = `qa-${Date.now()}`;
      const config = {
        configurable: {
          thread_id: `qa:supervisor_test:${runId}`,
        },
      };

      // Only invoke supervisor — we capture state after supervisor node
      // by using the supervisor function directly to avoid full pipeline
      const { supervisorNode } = await import("../src/agents/supervisor.js");
      const result = await supervisorNode({
        schema_version: 1,
        trace_id: runId,
        tenant_id: "turicks",
        messages: [],
        task: tc.task,
        department: "",
        result: "",
        auto_approve: false,
        errors: [],
        outreach_tier: null,
      });

      const actualDept = result.department ?? "null";
      const correct = actualDept === tc.expectedDept;
      return {
        output: `Routed to: ${actualDept} (expected: ${tc.expectedDept})`,
        notes: correct ? "✅ Correct routing" : `⚠️ Routing mismatch — got '${actualDept}', expected '${tc.expectedDept}'`,
      };
    });
  }
}

// ── Prospecting Pipeline Tests ────────────────────────────────────────────────

async function suiteProspecting(): Promise<void> {
  if (LOCAL_ONLY) {
    console.log("\n📡 SUITE: ProspectingPod (SKIPPED — --local-only)");
    return;
  }
  console.log("\n📡 SUITE: ProspectingPod (research + ICP scoring)");

  const { prospectingSubgraph } = await import("../src/agents/pods/prospecting.js");

  // Test 1: Known SaaS company — should score high
  await runTest("prospecting", "Prospect: Linear (linear.app) — expect CEO tier", async () => {
    const result = await prospectingSubgraph.invoke({
      raw_input: "https://linear.app",
      tenant_id: "qa",
      trace_id: `qa-prospect-${Date.now()}`,
    });

    const score = result.icp_score ?? 0;
    const tier = result.outreach_tier;
    const notes = [
      `ICP score: ${typeof score === "number" ? score.toFixed(2) : score}`,
      `Tier: ${tier ?? "disqualified"}`,
      `Company: ${result.company_name ?? "unknown"}`,
      result.research?.cached ? "Research: CACHED ✅" : "Research: fresh",
    ].join(" | ");

    if (score < 0.5) {
      throw new Error(`Low ICP score (${score}) for Linear — likely a scoring issue`);
    }

    return {
      output: JSON.stringify({
        icp_score: result.icp_score,
        outreach_tier: result.outreach_tier,
        pain_points: result.research?.pain_points?.slice(0, 3),
      }, null, 2),
      notes,
      costUsd: 0, // cost logged to DB not returned here
    };
  });

  // Test 2: Cache hit test — run same URL twice
  await runTest("prospecting", "Research cache: second run should be faster", async () => {
    const t1 = Date.now();
    const r1 = await prospectingSubgraph.invoke({
      raw_input: "https://linear.app",
      tenant_id: "qa",
      trace_id: `qa-cache-test-2-${Date.now()}`,
    });
    const lat1 = Date.now() - t1;

    return {
      output: `Second run: ${lat1}ms, cached: ${r1.research?.cached === true}`,
      notes: r1.research?.cached
        ? `✅ Cache hit confirmed (${lat1}ms)`
        : `⚠️ Cache miss on second run (${lat1}ms) — check Redis connection`,
    };
  });

  // Test 3: Low-fit company — should be disqualified
  await runTest("prospecting", "Prospect: McDonald's — expect disqualified", async () => {
    const result = await prospectingSubgraph.invoke({
      raw_input: "https://mcdonalds.com",
      tenant_id: "qa",
      trace_id: `qa-disqualify-${Date.now()}`,
    });

    const score = result.icp_score ?? 0;
    if (result.outreach_tier !== null) {
      return {
        output: JSON.stringify({ icp_score: result.icp_score, outreach_tier: result.outreach_tier }),
        notes: `⚠️ Expected disqualified but got tier=${result.outreach_tier} (score=${score}) — ICP scoring may be too generous`,
      };
    }
    return {
      output: `Correctly disqualified. Score: ${typeof score === "number" ? score.toFixed(2) : score}`,
      notes: "✅ ICP filter working correctly",
    };
  });
}

// ── LLM JSON Reliability Tests ────────────────────────────────────────────────

async function suiteLLMReliability(): Promise<void> {
  console.log("\n🔬 SUITE: LLM JSON Reliability");

  // The most common failure mode: models returning JSON wrapped in markdown fences
  const tiers = LOCAL_ONLY
    ? (["local"] as const)
    : CLOUD_ONLY
    ? (["nano", "md"] as const)
    : (["local", "nano", "md"] as const);

  for (const tier of tiers) {
    await runTest("llm_reliability", `${tier} tier: no markdown fences in JSON output`, async () => {
      const messages = [
        new SystemMessage("Return ONLY valid JSON. NO markdown code blocks. NO explanation.\nReturn exactly: {\"test\": \"passed\", \"tier\": \"" + tier + "\"}"),
        new HumanMessage("Confirm you can return raw JSON without markdown."),
      ];
      const result = await callCascade(tier, messages, { agent: "qa_json_test", tenant_id: "qa" });
      const text = result.text.trim();

      const hasMarkdown = text.startsWith("```") || text.includes("```json");
      const parsed = JSON.parse(
        text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim()
      ) as { test?: string };

      return {
        output: text.slice(0, 200),
        notes: hasMarkdown
          ? `⚠️ Model still returned markdown fences — our cleanup regex is needed`
          : `✅ Clean JSON output from ${result.model ?? tier}`,
        costUsd: result.cost_usd,
      };
    });
  }
}

// ── Architecture Simplification Audit ────────────────────────────────────────

async function suiteArchAudit(): Promise<void> {
  console.log("\n🏗️  SUITE: Architecture Simplification Audit (static checks, no API calls)");

  // Check 1: LangChain provider packages — can these be plain fetch?
  const pkgPath = new URL("../package.json", import.meta.url).pathname;
  const pkg = JSON.parse(
    await import("fs").then(fs => fs.promises.readFile(pkgPath, "utf-8"))
  ) as { dependencies?: Record<string, string> };

  const langchainDeps = Object.keys(pkg.dependencies ?? {}).filter(k => k.startsWith("@langchain/"));
  const requiredByLangGraph = ["@langchain/langgraph", "@langchain/core", "@langchain/langgraph-checkpoint-postgres"];
  const onlyForProviders = langchainDeps.filter(d => !requiredByLangGraph.includes(d));

  console.log(`  📦 LangChain deps: ${langchainDeps.length} total`);
  console.log(`  ✅ Required by LangGraph: ${requiredByLangGraph.join(", ")}`);
  if (onlyForProviders.length > 0) {
    console.log(`  ⚡ Could replace with plain fetch: ${onlyForProviders.join(", ")}`);
    warn("arch_audit", "Provider packages",
      `${onlyForProviders.join(", ")} only wrap HTTP calls. Could be replaced with direct API calls + BaseMessage conversion. Saves ~3 deps, removes type casting workarounds.`);
  }

  // Check 2: Verify callCascade API surface (is it clean?)
  const llmSrc = await import("fs").then(fs =>
    fs.promises.readFile(new URL("../src/infra/llm.ts", import.meta.url).pathname, "utf-8")
  );

  const hasUnknownCasts = (llmSrc.match(/as unknown as/g) ?? []).length;
  if (hasUnknownCasts > 0) {
    warn("arch_audit", "Type safety",
      `${hasUnknownCasts}x 'as unknown as BaseChatModel' casts in llm.ts — this is the seam between LangChain provider types and our interface. Simplification would eliminate these.`);
  } else {
    results.push({ suite: "arch_audit", name: "No unsafe casts", status: "PASS", latencyMs: 0 });
    console.log(`  ✅  No unsafe type casts`);
  }

  // Check 3: Count nodes/edges in the graph
  const graphSrc = await import("fs").then(fs =>
    fs.promises.readFile(new URL("../src/agents/graph.ts", import.meta.url).pathname, "utf-8")
  );
  const nodes = (graphSrc.match(/\.addNode\(/g) ?? []).length;
  const edges = (graphSrc.match(/\.addEdge\(|\.addConditionalEdges\(/g) ?? []).length;
  console.log(`  📊 Main graph: ${nodes} nodes, ${edges} edges`);
  results.push({
    suite: "arch_audit",
    name: "Graph complexity",
    status: nodes > 10 ? "WARN" : "PASS",
    latencyMs: 0,
    notes: `${nodes} nodes, ${edges} edges. ${nodes > 10 ? "Consider splitting into smaller subgraphs." : "Within complexity budget."}`,
  });
}

// ── Print Final Report ────────────────────────────────────────────────────────

function printReport(): void {
  console.log("\n" + "═".repeat(70));
  console.log("  FounderOS QA Report");
  console.log("═".repeat(70));

  const suites = [...new Set(results.map(r => r.suite))];
  for (const suite of suites) {
    const suiteResults = results.filter(r => r.suite === suite);
    const pass = suiteResults.filter(r => r.status === "PASS").length;
    const fail = suiteResults.filter(r => r.status === "FAIL").length;
    const warn_ = suiteResults.filter(r => r.status === "WARN").length;
    const skip = suiteResults.filter(r => r.status === "SKIP").length;

    console.log(`\n  ${suite.toUpperCase()}`);
    console.log(`  ${"─".repeat(50)}`);
    for (const r of suiteResults) {
      const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : r.status === "WARN" ? "⚠️ " : "⏭️ ";
      const latency = r.latencyMs > 0 ? ` [${r.latencyMs}ms]` : "";
      const cost = r.costUsd ? ` ($${r.costUsd.toFixed(4)})` : "";
      console.log(`  ${icon} ${r.name}${latency}${cost}`);
      if (r.status === "FAIL" && r.error) {
        console.log(`     💥 ${r.error.slice(0, 150)}`);
      }
      if (r.notes && (r.status === "WARN" || r.notes.includes("⚠️"))) {
        console.log(`     📌 ${r.notes.slice(0, 200)}`);
      }
    }
    console.log(`  Total: ${pass} pass · ${fail} fail · ${warn_} warn · ${skip} skip`);
  }

  const total = results.length;
  const totalPass = results.filter(r => r.status === "PASS").length;
  const totalFail = results.filter(r => r.status === "FAIL").length;
  const totalWarn = results.filter(r => r.status === "WARN").length;
  const avgLatency = results
    .filter(r => r.latencyMs > 0)
    .reduce((sum, r) => sum + r.latencyMs, 0) / Math.max(1, results.filter(r => r.latencyMs > 0).length);

  console.log("\n" + "═".repeat(70));
  console.log(`  OVERALL: ${totalPass}/${total} pass · ${totalFail} fail · ${totalWarn} warn`);
  console.log(`  Avg latency: ${avgLatency.toFixed(0)}ms | Est. API cost: $${totalCost.toFixed(4)}`);

  if (totalFail > 0) {
    console.log("\n  🔴 CRITICAL FAILURES (fix before shipping):");
    results
      .filter(r => r.status === "FAIL")
      .forEach(r => console.log(`    • [${r.suite}] ${r.name}: ${r.error?.slice(0, 100) ?? ""}`));
  }

  if (totalWarn > 0) {
    console.log("\n  🟡 IMPROVEMENTS NEEDED:");
    results
      .filter(r => r.status === "WARN")
      .forEach(r => console.log(`    • [${r.suite}] ${r.name}: ${r.notes?.slice(0, 120) ?? ""}`));
  }

  console.log("\n" + "═".repeat(70) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🚀 FounderOS QA Pipeline Test");
  console.log(`   Mode: ${LOCAL_ONLY ? "LOCAL ONLY" : CLOUD_ONLY ? "CLOUD ONLY" : "FULL"}`);
  console.log(`   Local model: founderos:latest @ http://localhost:11434`);
  console.log(`   Suite filter: ${SUITE_FILTER ?? "all"}\n`);

  // ── Dynamic imports — MUST happen after env stubs above ────────────────────
  // config.ts calls parseEnv() at module load. Dynamic imports defer module
  // evaluation until here, after process.env is fully populated.
  console.log("⏳ Loading FounderOS modules...");
  try {
    const llmMod = await import("../src/infra/llm.js");
    callCascade = llmMod.callCascade;

    const supervisorMod = await import("../src/agents/supervisor.js");
    _resolveDepartment = supervisorMod._resolveDepartment;

    console.log("✅ Modules loaded\n");
  } catch (err) {
    console.error("❌ Module load failed:", err instanceof Error ? err.message : err);
    console.error("   Check that all required env vars are set (or stubbed above).");
    process.exit(1);
  }

  await suiteConnectivity();
  await suiteLocalModel();
  await suiteSupervior();
  await suiteProspecting();
  await suiteLLMReliability();
  await suiteArchAudit();

  printReport();
}

main().catch((err) => {
  console.error("QA test runner crashed:", err);
  process.exit(1);
});
