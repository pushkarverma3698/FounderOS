/**
 * FounderOS — Golden Eval Tasks
 * ==============================
 * A fixed, representative set of inputs covering all six departments and the
 * HITL gate. This is the regression baseline: `pnpm eval` runs each through the
 * live office and scores routing, tool selection, and approval-gate coverage.
 *
 * Expectations are conservative — set only where we are confident — so a failure
 * is a real signal, not a flaky over-specification. Add cases as behaviour grows.
 */

import type { GoldenTask } from "./types.js";

export const GOLDEN_TASKS: GoldenTask[] = [
  // ── Research (read-only) ──────────────────────────────────────────────────
  {
    id: "research-company",
    input: "Research what Stripe does and summarise it in two lines.",
    expectedRoute: "research",
    expectedTools: ["search_web"],
    expectsHitl: false,
  },
  {
    id: "research-news",
    input: "What's the latest news on LangGraph?",
    expectedRoute: "research",
    expectsHitl: false,
  },

  // ── Comms (email read = no gate, send = gated) ────────────────────────────
  {
    id: "comms-read-inbox",
    input: "Check my unread emails.",
    expectedRoute: "comms",
    expectedTools: ["read_emails"],
    expectsHitl: false,
  },
  {
    id: "comms-send-known",
    input: "Email our client alex@acme.com a short thank-you note for the call.",
    expectedRoute: "comms",
    expectedTools: ["send_email"],
    expectsHitl: true,
  },

  // ── Engineering (read = no gate, write = gated, code-in-reply = no gate) ───
  {
    id: "eng-write-code",
    input: "Write a TypeScript function that validates an email address.",
    expectedRoute: "engineering",
    expectsHitl: false,
  },
  {
    id: "eng-list-repos",
    input: "List my GitHub repositories.",
    expectedRoute: "engineering",
    expectedTools: ["github_read"],
    expectsHitl: false,
  },
  {
    id: "eng-create-issue",
    input: "Create a GitHub issue on pushkarverma3698/FounderOS titled 'Add eval harness CI'.",
    expectedRoute: "engineering",
    expectedTools: ["github_write"],
    expectsHitl: true,
  },

  // ── Marketing (LinkedIn drafting = gated) ─────────────────────────────────
  {
    id: "mktg-linkedin-post",
    input: "Draft a LinkedIn post about how we built an AI multi-agent system in 3 weeks.",
    expectedRoute: "marketing",
    expectedTools: ["linkedin_post"],
    expectsHitl: true,
  },

  // ── Sales (cold outreach = gated) ─────────────────────────────────────────
  {
    id: "sales-cold-outreach",
    input: "Draft a cold outreach email to the founder of Acme, an EU SaaS startup.",
    expectedRoute: "sales",
    expectedTools: ["send_email"],
    expectsHitl: true,
  },

  // ── Prospecting (scoring = read-only) ─────────────────────────────────────
  {
    id: "prospecting-score",
    input: "Score Acme Corp as a Turicks prospect against our ICP.",
    expectedRoute: "prospecting",
    expectsHitl: false,
  },
];
