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
 * (update_context) or with /focus and /projects. This file only bootstraps an
 * empty or new row, and dates what it writes (context_meta) so a value the seed
 * wrote never reads as one the founder confirmed.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/seed-founder-context.ts
 */

import { buildDepartmentsSummary } from "../src/agents/capabilities.js";
import { seedFounderContextDefaults } from "../src/db/queries.js";

const TENANT = process.env["FOUNDER_TENANT"] ?? "turicks";

const context = {
  // ── Identity ────────────────────────────────────────────────────────────────
  founder: "Pushkar Verma",
  companies: "Turicks (The Autonomous Studio) + Naggar Retreat (Himalayan farm homestay)",
  location: "Amsterdam, Netherlands (global remote delivery)",

  // ── Tech stack ──────────────────────────────────────────────────────────────
  // ── FounderOS architecture — SYSTEM_CONTEXT_KEYS: the code owns these, and ──
  // the seed rewrites a stored value that differs (src/db/founder-context.ts).
  // Name no model slug here: scripts/apply-prod-env-overrides.sh is the source.
  tech_stack:
    "v3 deterministic kernel: LangGraph StateGraph — planner LLM, pure-code supervisor, 8 workers with capped tools, synthesizer — with Zod-validated contracts at every boundary (src/kernel/contracts.ts). TypeScript strict, Node 22 ESM, Postgres + pgvector + Drizzle ORM, grammy (Telegram). Paid Gemini Flash at temperature 0, same-key Gemini then free OpenRouter fallbacks (live chain: scripts/apply-prod-env-overrides.sh). Ollama nomic-embed-text for RAG embeddings, gws for Gmail/Calendar, direct LinkedIn API. Engineering work goes to Antigravity via GitHub issues (agent-dispatch) and is reviewed by Claude (pr-brain).",

  local_models:
    "Ollama on VPS: nomic-embed-text for turicks-brain vector sync. All RAG embeddings stay on-machine (ADR-013/015).",

  // Generated from the live tool registry (src/agents/capabilities.ts), so it cannot drift from the code.
  founderos_departments: buildDepartmentsSummary(),

  founderos_key_features:
    "Contracts-first kernel: every step result is validated, and an action claim needs a code-recorded tool receipt, so the reply cannot claim work that did not happen. Failures name the real stage and component and are always shown. HITL: approval row written before the interrupt, side effects only after the tap, idempotency key before every external send. Crash-safe threads (Postgres checkpointing; only /reset wipes). Jobhunt lane for two candidates (daily brief, tailored CV PDFs, apply links). Hybrid RAG (pgvector + keyword, RRF) over turicks-brain. Antigravity dispatch loop with Claude PR gate. Read-only MCP hub for coding tools.",

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

  naggar_retreat:
    "Himalayan farm homestay in Naggar, Himachal Pradesh. Separate from Turicks GTM — booking/guest comms only.",

  // ── Job search (parallel track — ADR-013 boundary with personal-rag) ───────
  target_roles:
    "AI Engineer, Agent Engineer, LangGraph Specialist — production multi-agent systems, eval harness, HITL",
  target_salary: "€120K–€180K EUR (Amsterdam/remote EU) or equivalent",

  // NOTE: current_priorities, next_actions, open_decisions and recent_wins were
  // removed 2026-09-28, and current_focus, active_projects, proof_gallery and
  // portfolio_signal 2026-09-29. All eight were June values, and "What's my
  // focus?" answered with them. What the founder is working on is HIS to say
  // (/focus, /projects, update_context), not compile-time seed data. Do not add a
  // key back that RETIRED_SEED_VALUES (src/db/retired-seed-values.ts) lists: the
  // deploy would remove it again, and the seed would fill it again.
};

async function main() {
  console.log("Seeding founder context defaults (fill-only) for tenant:", TENANT);
  const { filled, refreshed, retired, survived, dated, metaProblems } = await seedFounderContextDefaults(TENANT, context);
  const kept = Object.keys(context).filter((key) => !filled.includes(key) && !refreshed.includes(key));
  console.log(
    filled.length > 0
      ? `✅ Filled ${filled.length} absent key(s): ${filled.join(", ")}`
      : "✅ Nothing to fill — every seed key is already stored",
  );
  if (refreshed.length > 0) console.log(`✅ Rewrote ${refreshed.length} system key(s) the code owns: ${refreshed.join(", ")}`);
  if (retired.length > 0) console.log(`✅ Removed ${retired.length} retired June seed value(s) nobody had changed: ${retired.join(", ")}`);
  if (survived.length > 0) {
    console.log(`   Kept ${survived.length} stored value(s) under keys the seed used to write (founder-confirmed, edited since, or an older seed text nobody listed): ${survived.join(", ")}`);
  }
  if (dated.length > 0) console.log(`✅ Dated ${dated.length} code-owned key(s) that already matched the code: ${dated.join(", ")}`);
  for (const problem of metaProblems) console.log(`⚠️ Rebuilt the per-key dates because they were unreadable (${problem}); every founder fact reads "date unknown" until he confirms it`);
  if (kept.length > 0) {
    console.log(`   Kept the stored value (not overwritten) for ${kept.length} key(s): ${kept.join(", ")}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exit(1);
});
