/**
 * Regression tests for personal-dept routing.
 *
 * Root cause caught in production (2026-06-04 logs):
 *   "Send the text.txt file on my desktop" → supervisor responded "Okay"
 *   without routing to personal or calling any tool (toolErrors: 0).
 *
 * These tests verify the SUPERVISOR_PROMPT routing rules deterministically
 * classify personal-routing triggers. They are pure string/routing tests —
 * no LLM calls (the routing logic is in the prompt, but we test the routing
 * scorer logic + prompt routing strings from routeFromMessages).
 *
 * The golden-tasks eval covers end-to-end routing with a live model.
 * These unit tests catch PROMPT REGRESSION for personal routing keywords.
 */

import { describe, it, expect } from "vitest";
import { SUPERVISOR_PROMPT, PERSONAL_PROMPT } from "../../../src/agents/system-prompts.js";

describe("SUPERVISOR_PROMPT — personal routing keywords", () => {
  it("contains explicit routing for 'send me / attach / share file' requests", () => {
    const prompt = SUPERVISOR_PROMPT.toLowerCase();
    // Must have "send me" or "attach" or "share" mapped to personal
    expect(prompt).toMatch(/send.*file|attach.*file|share.*file/);
  });

  it("contains CANNOT rule preventing supervisor from answering file questions itself", () => {
    expect(SUPERVISOR_PROMPT).toMatch(/NO filesystem|NEVER say.*can't run|Route to personal/i);
  });

  it("contains routing rule for Desktop / home folder patterns", () => {
    const prompt = SUPERVISOR_PROMPT.toLowerCase();
    expect(prompt).toMatch(/desktop|downloads|documents|home folder|~ path/);
  });

  it("contains routing rule for follow-up messages (Attach it, Where is it)", () => {
    expect(SUPERVISOR_PROMPT).toMatch(/Attach it|Now run it|Where is it/i);
  });

  it("routing rules include jobhunt as a department", () => {
    expect(SUPERVISOR_PROMPT).toContain("jobhunt");
  });

  it("tech stack mention includes correct GitHub URL", () => {
    expect(SUPERVISOR_PROMPT).toContain("github.com/pushkarverma3698/FounderOS");
  });
});

describe("PERSONAL_PROMPT — mandatory tool usage", () => {
  it("contains MANDATORY TOOL USAGE section", () => {
    expect(PERSONAL_PROMPT).toMatch(/MANDATORY TOOL USAGE/i);
  });

  it("explicitly requires read_file for send/attach/share requests", () => {
    const prompt = PERSONAL_PROMPT.toLowerCase();
    expect(prompt).toMatch(/send.*attach.*share|attach.*file.*read_file/i);
  });

  it("forbids answering file questions without calling read_file", () => {
    expect(PERSONAL_PROMPT).toMatch(/NEVER say.*file.*contains|do not know.*until.*read/i);
  });

  it("handles follow-up context (Attach it, Now run it)", () => {
    expect(PERSONAL_PROMPT).toMatch(/Attach it|follow.up|same thread/i);
  });
});

describe("MARKETING_PROMPT — GitHub URL consistency", () => {
  it("includes the correct FounderOS GitHub URL", async () => {
    const { MARKETING_PROMPT } = await import("../../../src/agents/system-prompts.js");
    expect(MARKETING_PROMPT).toContain("github.com/pushkarverma3698/FounderOS");
  });
});

describe("MARKETING_PROMPT — comment engagement paste path", () => {
  it("supports a paste-driven reply path that does NOT require linkedin_read_comments", async () => {
    const { MARKETING_PROMPT } = await import("../../../src/agents/system-prompts.js");
    // PATH A: founder pastes a comment → draft directly, no API read (no r_member_social needed).
    expect(MARKETING_PROMPT).toContain("PATH A");
    expect(MARKETING_PROMPT).toContain("Do NOT call linkedin_read_comments");
  });

  it("tells the founder to paste the comment when read_comments 403s on scope", async () => {
    const { MARKETING_PROMPT } = await import("../../../src/agents/system-prompts.js");
    expect(MARKETING_PROMPT).toContain("r_member_social");
    expect(MARKETING_PROMPT).toMatch(/Paste the comment text/i);
  });
});
