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

  // ── Sales (research-conditional outreach) ─────────────────────────────────
  // Sales is deliberately research-conditional: the agent researches the prospect
  // and may decline to send if it can't verify a fit (correct, safe behaviour).
  // So we assert only what is deterministic here — routes to sales and researches.
  // The send_email → HITL gate is covered deterministically by `comms-send-known`
  // (same gated tool, known recipient, no research dependency).
  {
    id: "sales-research-outreach",
    input: "Draft cold outreach to the founder of Acme, an EU SaaS startup — research them first for a specific hook.",
    expectedRoute: "sales",
    expectedTools: ["search_web"],
    note: "Sales researches before drafting; sending is conditional on a verified fit.",
  },

  // ── Prospecting (scoring = read-only) ─────────────────────────────────────
  {
    id: "prospecting-score",
    input: "Score Acme Corp as a Turicks prospect against our ICP.",
    expectedRoute: "prospecting",
    expectsHitl: false,
  },

  // ── Personal (laptop operator: read = no gate, write/shell = gated) ────────
  {
    id: "personal-read-file",
    input: "Read the file ~/.zshrc on my laptop and tell me what's in it.",
    expectedRoute: "personal",
    expectedTools: ["read_file"],
    expectsHitl: false,
  },
  {
    id: "personal-run-script",
    input: "Run `git status` in my ~/Projects/founderos folder on my Mac.",
    expectedRoute: "personal",
    expectedTools: ["run_shell"],
    expectsHitl: true,
  },
  {
    id: "personal-browser",
    input: "Open https://news.ycombinator.com in my Safari browser.",
    expectedRoute: "personal",
    expectedTools: ["browser"],
    expectsHitl: true,
  },
  {
    // Regression guard for the stale "can't send attachments" prompt bug:
    // "send/attach the file" must route to personal → send_file (HITL), NOT read_file.
    id: "personal-send-file",
    input: "Send me the file ~/Desktop/report.pdf as an attachment in this chat.",
    expectedRoute: "personal",
    expectedTools: ["send_file"],
    expectsHitl: true,
  },

  // ── Job-Hunt (read-only research + HITL-gated send) ───────────────────────
  {
    id: "jobhunt-find-roles",
    input: "Search for LangGraph AI engineer jobs in Amsterdam and tell me what's available.",
    expectedRoute: "jobhunt",
    expectedTools: ["search_jobs"],
    expectsHitl: false,
  },
  {
    id: "jobhunt-draft-application",
    input: "Find open AI engineer positions at companies using LangGraph and draft a tailored outreach email to the best fit.",
    expectedRoute: "jobhunt",
    expectedTools: ["read_cv", "search_jobs"],
    expectsHitl: true, // send_email fires HITL before sending
    note: "jobhunt reads CV + searches jobs, then send_email is HITL-gated.",
  },

  // ── Engineering build workflow (project_workflow) ─────────────────────────
  {
    id: "eng-build-feature",
    input: "Create a new GitHub issue on pushkarverma3698/FounderOS titled 'feat: add job-hunt golden eval tasks' with a body describing the test.",
    expectedRoute: "engineering",
    expectedTools: ["github_write"],
    expectsHitl: true,
  },
];
