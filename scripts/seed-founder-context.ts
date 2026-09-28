/**
 * Seed DEFAULTS for the founder context — fill-only.
 * deploy/deploy.sh and scripts/vps-prod-stabilize.sh run this on every deploy.
 *
 * A key below is written only when the stored context LACKS it. A key the
 * founder saved through update_context (current_priorities, next_actions, …) is
 * never overwritten, and `last_updated` is never touched. Until 2026-09-28 this
 * script merged seed-over-stored, so every deploy replaced the founder's own
 * priorities with this file's June values.
 *
 * Consequence: editing a value here does NOT change a tenant that already has
 * that key. The founder changes stored context by telling the bot
 * (update_context). This file only bootstraps an empty or new row.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/seed-founder-context.ts
 */

import { seedFounderContextDefaults } from "../src/db/queries.js";

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

  // ── Tech stack ──────────────────────────────────────────────────────────────
  tech_stack:
    "LangGraph JS (createSupervisor + createReactAgent), Gemini 3.8 Flash via Google AI Studio, TypeScript 5.5 strict, Node 22 ESM, Postgres + pgvector + Drizzle ORM, grammy (Telegram), LangSmith tracing, Ollama (nomic-embed-text for turicks-brain RAG), gws (Gmail/Calendar default), direct LinkedIn API",

  local_models:
    "Ollama on VPS: nomic-embed-text for turicks-brain vector sync. All RAG embeddings stay on-machine (ADR-013/015).",

  // ── FounderOS architecture ──────────────────────────────────────────────────
  founderos_departments:
    "7 departments: admin (read_context, update_context), research (search_web, search_knowledge, search_turicks_brain), comms (send_email*, read_emails), engineering (github_read, github_write*, claude_code*, deploy_static_site*), marketing (search_web, search_knowledge, search_turicks_brain, linkedin_post*, publish_signal), sales (search_web, search_knowledge, search_turicks_brain, send_email*, publish_signal), personal (file/shell/browser*, path-guarded), jobhunt (search_jobs, read_cv, send_email*). * = HITL-gated",

  founderos_key_features:
    "Dual turicks-brain (knowledge_entries keyword + brain_memories pgvector semantic, ADR-038), execution guards (ADR-032 anti-fabrication), crash-safe HITL (Postgres checkpointing), idempotency audit log, typed dept_signals (design_brief_ready, site_deployed), JARVIS web gateway on :3001, deploy_static_site for proof.turicks.com showcases",

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
    "proof.turicks.com — 3 showcases planned (AgentOps fictional AI observability = showcase-1). IP fallback: http://YOUR_VPS_IP/showcase-1/",

  naggar_retreat:
    "Himalayan farm homestay in Naggar, Himachal Pradesh. Separate from Turicks GTM — booking/guest comms only.",

  // ── Job search (parallel track — ADR-013 boundary with personal-rag) ───────
  target_roles:
    "AI Engineer, Agent Engineer, LangGraph Specialist — production multi-agent systems, eval harness, HITL",
  target_salary: "€120K–€180K EUR (Amsterdam/remote EU) or equivalent",
  portfolio_signal:
    "FounderOS: production LangGraph multi-agent OS — github.com/pushkarverma3698/FounderOS",

  // NOTE: current_priorities, next_actions, open_decisions, and recent_wins
  // removed 2026-09-28 — they were from June and caused "What's my focus?"
  // to answer with stale data. The bot should use update_context / read_context
  // (admin dept) for live priorities, not compile-time seed data.
};

async function main() {
  console.log("Seeding founder context defaults (fill-only) for tenant:", TENANT);
  const filled = await seedFounderContextDefaults(TENANT, context);
  const kept = Object.keys(context).filter((key) => !filled.includes(key));
  console.log(
    filled.length > 0
      ? `✅ Filled ${filled.length} absent key(s): ${filled.join(", ")}`
      : "✅ Nothing to fill — every seed key is already stored",
  );
  if (kept.length > 0) {
    console.log(`   Kept the stored value (not overwritten) for ${kept.length} key(s): ${kept.join(", ")}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exit(1);
});
