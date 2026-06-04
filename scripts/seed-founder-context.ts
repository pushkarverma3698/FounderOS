/**
 * Seed the founder context with current Turicks business state.
 * Run once (idempotent — safe to re-run, merges rather than replaces).
 *
 * Update this whenever business state changes significantly.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/seed-founder-context.ts
 */

import { upsertFounderContext } from "../src/db/queries.js";

const TENANT = process.env["FOUNDER_TENANT"] ?? "turicks";

const context = {
  // ── Identity ────────────────────────────────────────────────────────────────
  founder: "Pushkar Verma",
  companies: "Turicks (AI automation agency) + Naggar Retreat (Himalayan farm homestay)",
  location: "Amsterdam, Netherlands",

  // ── Active work ─────────────────────────────────────────────────────────────
  current_focus: "FounderOS launch + job search (AI/agent engineering roles) + Turicks outbound",

  active_projects: [
    "FounderOS v2 — production LangGraph multi-agent system (7 departments, Postgres checkpointing, HITL, eval harness 13/13, 271 tests) — NOW PUBLIC on GitHub",
    "Turicks agency — AI automation builds for SME founders",
    "Naggar Retreat — Himalayan farm homestay in Himachal Pradesh",
  ],

  current_priorities: [
    "Land AI/agent engineering job (LangGraph specialist) — portfolio is FounderOS",
    "Close first Turicks retainer client ($3-5K setup + $1.5K/mo)",
    "Build-in-public: weekly LinkedIn BUILD_LOG posts via FounderOS marketing dept",
    "Ship remaining features: job-hunt department, real RAG for turicks-brain",
  ],

  // ── Tech stack ──────────────────────────────────────────────────────────────
  tech_stack: "LangGraph JS (createSupervisor + createReactAgent), Gemini 2.5 Flash, TypeScript 5.5 strict, Node 22 ESM, Postgres + Drizzle ORM, Redis, Composio (Gmail/LinkedIn/GitHub OAuth), Firecrawl (web search), grammY (Telegram bot), LangSmith (tracing), Ollama (local models: qwen2.5:7b for JSON extraction + commit messages, nomic-embed-text for embeddings)",

  local_models: "Yes — Ollama running locally with qwen2.5:7b (code/JSON tasks) and nomic-embed-text (embeddings). Saves ~40% of API costs on structured tasks. Configured via mcp__ollama__generate and mcp__ollama__embed tools in Claude Code.",

  // ── FounderOS architecture ──────────────────────────────────────────────────
  founderos_departments: "7 departments: research (search_web, search_knowledge, read_emails), comms (send_email*, linkedin_post*), engineering (github_read, github_write*), marketing (search_web, linkedin_post*), sales (search_web, send_email*), prospecting (search_web, search_knowledge), personal (read_file, list_dir, write_file*, run_shell*, browser*). * = HITL-gated via interrupt()",

  founderos_key_features: "Crash-safe HITL (Postgres checkpointing), idempotency (SHA-1 key before every external action), path-guard ($HOME confinement, secrets blocked on read), deterministic eval harness (13/13 100%), brand validator (banned phrases), per-run budget cap ($0.50 default), MCP server (search_web/github_read/read_context), 300 tests, tsc clean",

  // ── Business context ────────────────────────────────────────────────────────
  turicks_services: "AI agents (LangGraph multi-agent systems), full-stack SaaS (Next.js/TypeScript), UI/UX design, cloud infra, business automation workflows. 3-5 day delivery of working code (not decks).",

  turicks_pricing: "$500 starter engagement + $5,000/month retainer",
  turicks_icp: "SME founders $50K-500K ARR in EU/US, pain = no tech co-founder, want working AI/automation fast",
  turicks_positioning: "Safe, evaluated, budget-capped agent actions — the production-hardening layer most agent projects skip",

  naggar_retreat: "Himalayan farm homestay in Naggar, Himachal Pradesh. Focus: booking management, guest comms, seasonal marketing.",

  // ── Job search ──────────────────────────────────────────────────────────────
  target_roles: "AI Engineer, Agent Engineer, LangGraph Specialist — companies using LangGraph in production, multi-agent systems, agentic workflows",
  target_salary: "€120K-€180K EUR (Amsterdam/remote EU) or equivalent",
  portfolio_signal: "FounderOS: production LangGraph multi-agent system with eval harness, HITL approval gates, Postgres checkpointing, LangSmith tracing, 300 tests — github.com/pushkarverma3698/FounderOS",

  // ── Recent achievements ─────────────────────────────────────────────────────
  recent_wins: [
    "FounderOS v2 rebuilt from 10,678 LOC to ~500 LOC (ADR-010)",
    "Eval harness: 13/13 routing accuracy, 10/10 tool selection, 12/12 HITL coverage — all deterministic",
    "Personal department: path-guarded laptop operator with HITL (ADR-012, ADR-013)",
    "Budget guard: per-run token/$ cap with Telegram breach alert",
    "MCP server: search_web, github_read, read_context exposed via Model Context Protocol",
    "Repo made public (2026-06-04) — github.com/pushkarverma3698/FounderOS",
    "FounderOS markets itself: LinkedIn posts drafted by marketing dept, HITL-approved",
  ],

  // ── Next actions ────────────────────────────────────────────────────────────
  next_actions: [
    "Apply to 10-15 LangGraph-named AI engineer roles this week",
    "Record 90-second Loom demo of HITL approval flow for portfolio",
    "Send weekly LinkedIn BUILD_LOG post via FounderOS (every Monday)",
    "Ship job-hunt department (reads CV from personal-rag, researches company, HITL-drafts application)",
    "Populate turicks-brain with brand/strategy docs via pnpm brain:sync",
    "First outbound batch: 3-5 SME founders fitting Turicks ICP",
  ],

  // ── Open questions ──────────────────────────────────────────────────────────
  open_decisions: [
    "Which job to take: full-time AI engineer OR keep building FounderOS as open-core + consulting",
    "Gumroad LangGraph starter kit: launch when job hunt is in pipeline (2-3 weeks)",
  ],
};

async function main() {
  console.log("Seeding founder context for tenant:", TENANT);
  await upsertFounderContext(TENANT, context);
  console.log("✅ Founder context seeded with", Object.keys(context).length, "keys");
  console.log("Keys:", Object.keys(context).join(", "));
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exit(1);
});
