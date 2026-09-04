/**
 * buildJobhuntPrompt is already profile-parameterized — the T4 (2026-09-05)
 * bug was never in this function, it was that kernel-boot.ts called it once
 * at startup with no argument and froze the result. This just pins that the
 * function itself names whichever candidate it's given, so the per-turn
 * override wired in kernel-boot.ts (`promptForProfile`) has a correct prompt
 * to call.
 */

import { describe, it, expect } from "vitest";
import { buildJobhuntPrompt } from "../../../src/agents/prompts/jobhunt.js";
import { getProfile } from "../../../src/tools/jobhunt/profile-config.js";

describe("buildJobhuntPrompt", () => {
  it("names the given profile's candidate, not always the default", () => {
    const wife = buildJobhuntPrompt(getProfile("wife-nl-finance"));
    expect(wife).toContain("Tashi Goyal");
    expect(wife).not.toContain("Pushkar Verma");
  });

  it("names the default profile's candidate when called with no argument", () => {
    const pushkar = buildJobhuntPrompt();
    expect(pushkar).toContain("Pushkar Verma");
    expect(pushkar).not.toContain("Tashi Goyal");
  });

  it("read_cv's own line names the right candidate too — not just the opening sentence", () => {
    // The 2026-09-05 defect: read_cv was hardcoded to "Pushkar Verma's CV" at
    // the TOOL level. This pins the PROMPT's own read_cv line, which is what
    // actually reaches the model — the tool description itself is a separate,
    // still-open gap (see docs/sessions/2026-09-05-*.md Outstanding).
    const wife = buildJobhuntPrompt(getProfile("wife-nl-finance"));
    expect(wife).toMatch(/read_cv\s+→ read Tashi Goyal's CV/);
  });
});
