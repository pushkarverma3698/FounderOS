/**
 * FounderOS — Workflow Registry
 * ================================
 * All workflow definitions live here as typed config (not YAML).
 * Pure functions for lookup + template rendering — no I/O.
 */

import type { WorkflowDef } from "./types.js";

// ── Workflow definitions ───────────────────────────────────────────────────────

const WORKFLOWS: WorkflowDef[] = [
  {
    id: "onboarding",
    name: "Client Onboarding",
    description: "Score, research, draft welcome email, and create a GitHub repo for a new client.",
    params: ["company"],
    steps: [
      {
        id: "score",
        label: "ICP score",
        task: "Score {company} as a Turicks prospect — give an ICP score 1–10 with a one-paragraph verdict.",
      },
      {
        id: "research",
        label: "Company research",
        task: "Research {company}: find their current tech stack, team size, and the top 2 pain points most relevant to AI automation. Be specific and cite sources.",
      },
      {
        id: "welcome_email",
        label: "Draft welcome email",
        task: "Draft a personalised welcome email to the founder of {company}. Reference the specific pain points found in the research step. Max 150 words, Turicks brand voice. Then call send_email to request approval before sending.",
      },
      {
        id: "github_repo",
        label: "Create GitHub repo",
        task: "Create a private GitHub repository named 'turicks-{company}' on pushkarverma3698 with a starter README that mentions Turicks is partnering with {company} on AI automation. Use github_write.",
      },
    ],
  },
  {
    id: "outbound",
    name: "Outbound Sequence",
    description: "Score a prospect, find a hook, and draft a personalised cold email.",
    params: ["company"],
    steps: [
      {
        id: "score",
        label: "ICP score",
        task: "Score {company} against the Turicks ICP — give a score 1–10 and a short verdict. If score < 5, stop and say why it's not worth pursuing.",
      },
      {
        id: "hook",
        label: "Find outreach hook",
        task: "Find a specific hook for cold outreach to {company}: a recent product launch, press mention, job posting, or pain point visible in their public presence. Be specific.",
      },
      {
        id: "cold_email",
        label: "Draft cold email",
        task: "Draft a cold outreach email to the founder of {company} using the hook found in the previous step. Max 150 words. Subject ≤8 words. Sign as: Pushkar, Turicks. Then call send_email for approval.",
      },
    ],
  },
  {
    id: "weekly_digest",
    name: "Weekly Company Digest",
    description: "Summarise the week: key decisions, wins, open items, and next week's focus.",
    params: [],
    steps: [
      {
        id: "memory_review",
        label: "Review recent memory",
        task: "Search memory for significant events from the past 7 days: decisions made, deals moved, features shipped, client interactions. Summarise in bullet points.",
      },
      {
        id: "open_items",
        label: "Open items",
        task: "Based on the context and memory, list the top 3 open items or blockers that need action this week. Be direct.",
      },
      {
        id: "next_week",
        label: "Plan next week",
        task: "Based on the review and open items, draft a short Monday brief: this week's focus (3 bullets), next actions (5 max), and one proactive suggestion. Format it for Telegram.",
      },
    ],
  },
];

// ── Public API (pure functions) ─────────────────────────────────────────────────

/** Look up a workflow by id. Returns undefined if not found. */
export function getWorkflow(id: string): WorkflowDef | undefined {
  return WORKFLOWS.find((w) => w.id === id);
}

/** Return all registered workflows. */
export function listWorkflows(): WorkflowDef[] {
  return WORKFLOWS;
}

/**
 * Replace {slot} placeholders in a template string with actual values.
 * Unknown slots are left as-is.
 */
export function renderTemplate(
  template: string,
  params: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(params, key)
      ? (params[key] ?? _match)
      : _match;
  });
}

/**
 * Parse the argument string of a /run command.
 * Format: `<workflow-id> [key=value ...]`
 * Values can be quoted: `key="multi word value"`
 *
 * Returns null for empty/invalid input.
 */
export function parseRunArgs(
  args: string,
): { id: string; params: Record<string, string> } | null {
  const trimmed = args.trim();
  if (!trimmed) return null;

  // First word is the workflow id; rest is the params string
  const spaceIdx = trimmed.indexOf(" ");
  const id = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  const params: Record<string, string> = {};
  if (!rest) return { id, params };

  // Find all key= positions (including keys in quoted values — handle quoted first)
  // Strategy: split on boundaries of the form /\w+=/ to capture multi-word values
  const keyRe = /(\w+)=/g;
  const keyMatches = [...rest.matchAll(keyRe)];

  for (let i = 0; i < keyMatches.length; i++) {
    const match = keyMatches[i]!;
    const key = match[1]!;
    const valueStart = match.index! + match[0].length;
    const valueEnd = i < keyMatches.length - 1 ? keyMatches[i + 1]!.index! : undefined;
    let value = rest.slice(valueStart, valueEnd).trim();
    // Strip surrounding quotes if present
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    params[key] = value;
  }

  return { id, params };
}
