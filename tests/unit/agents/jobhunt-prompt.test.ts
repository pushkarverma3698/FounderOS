/**
 * buildJobhuntPrompt is already profile-parameterized — the T4 (2026-09-05)
 * bug was never in this function, it was that kernel-boot.ts called it once
 * at startup with no argument and froze the result. This just pins that the
 * function itself names whichever candidate it's given, so the per-turn
 * override wired in kernel-boot.ts (`promptForProfile`) has a correct prompt
 * to call.
 *
 * 2026-09-07: the PRIMARY identity assertions below were tightened to check
 * the opening sentence specifically, not "does not contain the other name"
 * anywhere in the prompt. `promptForProfile` only fires when a profileId is
 * already resolved (slash commands) — a free-text chat message never
 * resolves one, so it always runs under this same default-candidate prompt
 * even when the founder names the OTHER candidate by first name or "wife" in
 * plain English (job_state had no profile filter at all, so this went
 * unnoticed: see job-queries.ts's queryJobState). The prompt now
 * deliberately names every OTHER registered candidate too, as an explicit
 * escape hatch instructing the model to pass `profile` on job_state — that
 * is a second, correct reference to the other person, not a reintroduction
 * of the T4 identity-bleed bug.
 */

import { describe, it, expect } from "vitest";
import { buildJobhuntPrompt } from "../../../src/agents/prompts/jobhunt.js";
import { getProfile } from "../../../src/tools/jobhunt/profile-config.js";

describe("buildJobhuntPrompt", () => {
  it("names the given profile's candidate as the PRIMARY identity, not always the default", () => {
    const wife = buildJobhuntPrompt(getProfile("wife-nl-finance"));
    expect(wife).toMatch(/^You are the Job-Hunt department for Tashi Goyal\./);
  });

  it("names the default profile's candidate as the PRIMARY identity when called with no argument", () => {
    const pushkar = buildJobhuntPrompt();
    expect(pushkar).toMatch(/^You are the Job-Hunt department for Pushkar Verma\./);
  });

  it("read_cv's own line names the right candidate too — not just the opening sentence", () => {
    // The 2026-09-05 defect: read_cv was hardcoded to "Pushkar Verma's CV" at
    // the TOOL level. This pins the PROMPT's own read_cv line, which is what
    // actually reaches the model — the tool description itself is a separate,
    // still-open gap (see docs/sessions/2026-09-05-*.md Outstanding).
    const wife = buildJobhuntPrompt(getProfile("wife-nl-finance"));
    expect(wife).toMatch(/read_cv\s+→ read Tashi Goyal's CV/);
  });

  it("lists every OTHER registered candidate as an explicit job_state escape hatch", () => {
    const pushkar = buildJobhuntPrompt();
    expect(pushkar).toContain("OTHER REGISTERED CANDIDATES");
    expect(pushkar).toContain("Tashi Goyal");
    expect(pushkar).toContain('profile: "wife-nl-finance"');

    const wife = buildJobhuntPrompt(getProfile("wife-nl-finance"));
    expect(wife).toContain("OTHER REGISTERED CANDIDATES");
    expect(wife).toContain("Pushkar Verma");
    expect(wife).toContain('profile: "pushkar-nl-tech"');
  });
});
