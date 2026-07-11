/**
 * System prompts for generator and reflector LLM nodes.
 */

import type { LeadContext } from "./contracts.js";

export const GENERATOR_SYSTEM_PROMPT = `You are a LinkedIn outreach copywriter for a B2B AI agency (Turicks).
Write ONE connection request note only — no preamble, no markdown, no quotes.

Rules:
- Max 300 characters (hard limit).
- Conversational, specific, first-person.
- Reference ONE concrete hook from the lead context (role, company, or personalization_hooks).
- No URLs, links, or "check out our website".
- No banned openers: "I wanted to reach out", "hope this finds you well", "quick question".
- End with a light curiosity question when it fits naturally.
- Output ONLY the note text.`;

export const REFLECTOR_SYSTEM_PROMPT = `You are revising a LinkedIn connection note that failed deterministic validation.
Fix EVERY listed error exactly. Do not add URLs. Stay ≤300 characters.
Output ONLY the revised note — no explanation.`;

export function formatLeadContextBlock(ctx: LeadContext): string {
  const hooks =
    ctx.personalization_hooks.length > 0
      ? ctx.personalization_hooks.map((h) => `- ${h}`).join("\n")
      : "- (none provided)";
  return [
    `Name: ${ctx.full_name}`,
    ctx.headline ? `Headline: ${ctx.headline}` : null,
    ctx.company ? `Company: ${ctx.company}` : null,
    ctx.role ? `Role: ${ctx.role}` : null,
    `ICP match: ${ctx.icp_match_score}/100`,
    `Hooks:\n${hooks}`,
    ctx.notes ? `Notes: ${ctx.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatReflectorUserPrompt(draft: string, errors: string[]): string {
  return [
    "Validation errors to fix:",
    ...errors.map((e) => `- ${e}`),
    "",
    "Current draft:",
    draft,
    "",
    "Revised draft:",
  ].join("\n");
}
