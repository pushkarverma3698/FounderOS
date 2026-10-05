/**
 * FounderOS — seed values that were retired (data only)
 * ======================================================
 * scripts/seed-founder-context.ts wrote each of these into agents.founder_context.
 * The seed is fill-only, so once a value was stored no deploy ever corrected it, and
 * the bot kept quoting June as the present. A stored value still EQUAL to one listed
 * here (deeply, as JSONB reads it back) was written by the seed and never touched
 * since, so the next deploy removes it (reconcileSeededContext, founder-context.ts).
 * A value the founder saved under the same key differs, and stays. One he re-typed
 * identical is protected by its context_meta source ("founder"), not by its text.
 *
 * A key lists EVERY text the seed ever wrote for it. Prod holds whichever one was
 * current at the last seed-over-stored deploy (before 2026-09-28), not today's: the
 * seed's active_projects[0] read "FounderOS v2 — …" until #767 rewrote it, and the
 * prod row still holds the v2 line. Retiring only the seed's current text would have
 * left it in place.
 *
 * The values below were extracted from the seed's own git history by evaluating its
 * `context` literal at commits 071b61a (June text) and 0314ebd (#767), not retyped:
 * a value off by one character never equals what is stored, and is never retired.
 * tests/unit/db/founder-context.test.ts checks them against a fixture of the prod row.
 * None of these keys may return to the seed: it would write them back on the next
 * deploy (asserted in tests/unit/scripts/seed-founder-context.test.ts).
 */

export const RETIRED_SEED_VALUES: Readonly<Record<string, readonly unknown[]>> = {
  // Retired by #767 (2026-09-29): the seed dropped them in #760, which only edited the file.
  current_priorities: [
    [
      "Ship 3 live proof showcases at proof.turicks.com (showcase-1 AgentOps first)",
      "LinkedIn build-in-public: 3–5 posts/week via FounderOS marketing dept (HITL on every post)",
      "Proof Drops: 2–3 custom cinematic artifacts/week to AI/dev-tool seed–Series A target list",
      "Keep turicks-brain current: pnpm brain:sync after every strategy/ADR change",
      "Land first $8K+ Cinematic Launch Experience client (studio retainer $5K/mo after)",
    ],
  ],
  recent_wins: [
    [
      "FounderOS production live on Hetzner VPS since 2026-06-14 (GitHub Actions CD)",
      "Phases 1–6 hardening merged: context isolation, typed signals, Claude judge, execution guards",
      "turicks-brain dual RAG live (brain:sync + pgvector, Ollama embeddings)",
      "ICP guard fix: toolsCalled honored when dept tool messages hidden (2026-06-18)",
      "Prod hardcore QA: 6/6 office probes PASS including ICP grounding (T23/T24)",
      "Web design pipeline: claude_code + deploy_static_site + site_deployed signal wired",
    ],
  ],
  next_actions: [
    [
      "Deploy showcase-1 live at proof.turicks.com (vps-live-showcase.sh)",
      "Build showcases 2–3 per 05-SHOWCASE-BRIEF.md",
      "Compile 30-account AI/dev-tool target list for Proof Drops",
      "First LinkedIn BUILD_LOG post with showcase URL + FounderOS metrics (HITL approve)",
      "Configure prod LinkedIn token + gws auth",
      "First Proof Drop email to target founder (HITL approve send)",
    ],
  ],
  open_decisions: [
    [
      "proof.turicks.com DNS vs IP-only URLs for early outreach",
      "First paying client: project vs retainer entry point",
      "Cinematic Cloud SaaS vs studio-first — studio-first locked until $5K+ banked (SCALE gate)",
    ],
  ],

  // Retired 2026-09-29 with the four seed defaults that made "what is my focus?" answer with June's plan.
  current_focus: [
    "Phase D-Bis: 3 proof showcases on proof.turicks.com + LinkedIn build-in-public + Proof Drops to AI/dev-tool startups",
  ],

  // Two texts: prod holds the v2 one (the seed's until #767); a row seeded since #767 holds the v3 one.
  active_projects: [
    [
      "FounderOS v2 — production LangGraph multi-agent OS (7 departments, Postgres checkpointing, HITL, 1250+ tests) — LIVE on Hetzner VPS",
      "Cinematic Launch Experience — $8K+ DFY web design via cinematic-web presets + deploy_static_site pipeline",
      "Turicks proof gallery — showcase-1 (AgentOps) + 2 more showcases targeting Awwwards/Godly quality bar",
      "Naggar Retreat — Himalayan farm homestay in Himachal Pradesh (separate brand boundary)",
    ],
    [
      "FounderOS — deterministic agent kernel (v3) running Turicks operations over Telegram — LIVE on Hetzner VPS",
      "Cinematic Launch Experience — $8K+ DFY web design via cinematic-web presets + deploy_static_site pipeline",
      "Turicks proof gallery — showcase-1 (AgentOps) + 2 more showcases targeting Awwwards/Godly quality bar",
      "Naggar Retreat — Himalayan farm homestay in Himachal Pradesh (separate brand boundary)",
    ],
  ],

  // The IP fallback in proof_gallery is the literal placeholder http://YOUR_VPS_IP/showcase-1/.
  proof_gallery: [
    "proof.turicks.com — 3 showcases planned (AgentOps fictional AI observability = showcase-1). IP fallback: http://YOUR_VPS_IP/showcase-1/",
  ],
  portfolio_signal: [
    "FounderOS: production LangGraph multi-agent OS — github.com/pushkarverma3698/FounderOS",
  ],
};
