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
  companies: "Turicks (The Autonomous Studio) + Naggar Retreat (Himalayan farm homestay)",
  location: "Amsterdam, Netherlands (global remote delivery)",

  // ── Active work (Phase D-Bis — Proof & Distribution) ───────────────────────
  current_focus:
    "Phase D-Bis: 3 proof showcases on proof.turicks.com + LinkedIn build-in-public + Proof Drops to AI/dev-tool startups",

  active_projects: [
    "FounderOS v2 — production LangGraph multi-agent OS (7 departments, Postgres checkpointing, HITL, 1250+ tests) — LIVE on Hetzner VPS",
    "Cinematic Launch Experience — $8K+ DFY web design via cinematic-web presets + deploy_static_site pipeline",
    "Turicks proof gallery — showcase-1 (AgentOps) + 2 more showcases targeting Awwwards/Godly quality bar",
    "Naggar Retreat — Himalayan farm homestay in Himachal Pradesh (separate brand boundary)",
  ],

  current_priorities: [
    "Ship 3 live proof showcases at proof.turicks.com (showcase-1 AgentOps first)",
    "LinkedIn build-in-public: 3–5 posts/week via FounderOS marketing dept (HITL on every post)",
    "Proof Drops: 2–3 custom cinematic artifacts/week to AI/dev-tool seed–Series A target list",
    "Keep turicks-brain current: pnpm brain:sync after every strategy/ADR change",
    "Land first $8K+ Cinematic Launch Experience client (studio retainer $5K/mo after)",
  ],

  // ── Tech stack ──────────────────────────────────────────────────────────────
  tech_stack:
    "LangGraph JS (createSupervisor + createReactAgent), Gemini 2.5 Flash via OpenRouter, TypeScript 5.5 strict, Node 22 ESM, Postgres + pgvector + Drizzle ORM, grammy (Telegram), LangSmith tracing, Ollama (nomic-embed-text for turicks-brain RAG), gws (Gmail/Calendar default), direct LinkedIn API",

  local_models:
    "Ollama on VPS: nomic-embed-text for turicks-brain vector sync. All RAG embeddings stay on-machine (ADR-013/015).",

  // ── FounderOS architecture ──────────────────────────────────────────────────
  founderos_departments:
    "7 departments: admin (read_context, update_context), research (search_web, search_knowledge, search_turicks_brain), comms (send_email*, read_emails), engineering (github_read, github_write*, claude_code*, deploy_static_site*), marketing (search_web, search_knowledge, search_turicks_brain, linkedin_post*, publish_signal), sales (search_web, search_knowledge, search_turicks_brain, send_email*, publish_signal), personal (file/shell/browser*, path-guarded), jobhunt (search_jobs, read_cv, send_email*). * = HITL-gated",

  founderos_key_features:
    "Dual turicks-brain (knowledge_entries keyword + turicks_brain pgvector semantic), execution guards (ADR-032 anti-fabrication), crash-safe HITL (Postgres checkpointing), idempotency audit log, typed dept_signals (design_brief_ready, site_deployed), JARVIS web gateway on :3001, deploy_static_site for proof.turicks.com showcases",

  // ── Business context (ADR-033 / Phase D-Bis — locked 2026-06-17) ───────────
  turicks_services:
    "The Autonomous Studio — cinematic launch experiences for AI/dev-tool startups. Governed delivery via FounderOS (HITL, eval, audit). NOT generic web design or commodity SaaS builds.",

  turicks_pricing:
    "$8K minimum project (Cinematic Launch Experience) · $5K/mo minimum retainer · $8K–$25K+ done-for-you cinematic tier. Retired: $500 starter (commodity signal).",

  turicks_icp:
    "Funded AI/dev-tool startups (Seed–Series A). Need credible launch experience (not template landing page). Budget $8K+ project or $5K/mo retainer. Global remote. Disqualified: commodity website buyers, $500 seekers, enterprise RFP cycles.",

  turicks_positioning:
    "The Autonomous Studio for AI/dev-tool startups — governed AI delivery on FounderOS + cinematic design finish. FounderOS is live proof (1250+ tests, HITL on every external action).",

  website_builder:
    "cinematic-web presets (bundled in assets/cinematic-presets + optional CINEMATIC_WEB_PRESETS_ROOT clone) + apply_cinematic_preset → claude_code → deploy_static_site → nginx at proof.turicks.com/showcase-1/ and /clients/{slug}/. Commands: /webbuild Client preset slug, /run web_build. HITL on build + deploy.",

  proof_gallery:
    "proof.turicks.com — 3 showcases planned (AgentOps fictional AI observability = showcase-1). IP fallback: http://95.217.162.12/showcase-1/",

  naggar_retreat:
    "Himalayan farm homestay in Naggar, Himachal Pradesh. Separate from Turicks GTM — booking/guest comms only.",

  // ── Job search (parallel track — ADR-013 boundary with personal-rag) ───────
  target_roles:
    "AI Engineer, Agent Engineer, LangGraph Specialist — production multi-agent systems, eval harness, HITL",
  target_salary: "€120K–€180K EUR (Amsterdam/remote EU) or equivalent",
  portfolio_signal:
    "FounderOS: production LangGraph multi-agent OS — github.com/pushkarverma3698/FounderOS",

  // ── Recent achievements ─────────────────────────────────────────────────────
  recent_wins: [
    "FounderOS production live on Hetzner VPS since 2026-06-14 (GitHub Actions CD)",
    "Phases 1–6 hardening merged: context isolation, typed signals, Claude judge, execution guards",
    "turicks-brain dual RAG live (brain:sync + pgvector, Ollama embeddings)",
    "ICP guard fix: toolsCalled honored when dept tool messages hidden (2026-06-18)",
    "Prod hardcore QA: 6/6 office probes PASS including ICP grounding (T23/T24)",
    "Web design pipeline: claude_code + deploy_static_site + site_deployed signal wired",
  ],

  // ── Next actions ────────────────────────────────────────────────────────────
  next_actions: [
    "Deploy showcase-1 live at proof.turicks.com (vps-live-showcase.sh)",
    "Build showcases 2–3 per 05-SHOWCASE-BRIEF.md",
    "Compile 30-account AI/dev-tool target list for Proof Drops",
    "First LinkedIn BUILD_LOG post with showcase URL + FounderOS metrics (HITL approve)",
    "Configure prod LinkedIn token + gws auth (or GMAIL_BACKEND=composio rollback)",
    "First Proof Drop email to target founder (HITL approve send)",
  ],

  // ── Open questions ──────────────────────────────────────────────────────────
  open_decisions: [
    "proof.turicks.com DNS vs IP-only URLs for early outreach",
    "First paying client: project vs retainer entry point",
    "Cinematic Cloud SaaS vs studio-first — studio-first locked until $5K+ banked (SCALE gate)",
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
