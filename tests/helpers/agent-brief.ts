/**
 * Test helper — a complete agent brief, so a test can vary exactly one thing.
 *
 * Every one of the template's nine sections is present and non-empty; `sections` replaces the
 * text of individual ones and `tail` is appended after the last section.
 */

import { AGENT_BRIEF_HEADINGS, type AgentBriefHeading } from "../../src/tools/agent-brief-lint.js";

export function filledBrief(
  sections: Partial<Record<AgentBriefHeading, string>> = {},
  tail = "",
): string {
  return (
    AGENT_BRIEF_HEADINGS.map((heading) => `## ${heading}\n\n${sections[heading] ?? "Filled in."}\n`).join("\n") +
    tail
  );
}
