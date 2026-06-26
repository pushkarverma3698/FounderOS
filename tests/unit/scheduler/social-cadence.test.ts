/**
 * Unit tests for social cadence scheduler helpers.
 * Pure functions only — no cron, no LLM calls, no DB.
 */

import { describe, it, expect } from "vitest";
import { buildSocialCadencePrompt } from "../../../src/infra/scheduler.js";

describe("buildSocialCadencePrompt", () => {
  it("assigns BUILD_LOG on Monday", () => {
    // 2026-06-22 is a Monday
    const monday = new Date("2026-06-22T09:00:00.000Z");
    const { pillar } = buildSocialCadencePrompt(monday);
    expect(pillar).toBe("BUILD_LOG");
  });

  it("assigns AI_EDUCATION on Wednesday", () => {
    const wednesday = new Date("2026-06-24T09:00:00.000Z");
    const { pillar } = buildSocialCadencePrompt(wednesday);
    expect(pillar).toBe("AI_EDUCATION");
  });

  it("assigns FOUNDER_STORY on Friday", () => {
    const friday = new Date("2026-06-26T09:00:00.000Z");
    const { pillar } = buildSocialCadencePrompt(friday);
    expect(pillar).toBe("FOUNDER_STORY");
  });

  it("generates a stable thread ID for the same date", () => {
    const d = new Date("2026-06-22T09:00:00.000Z");
    const { threadId } = buildSocialCadencePrompt(d);
    expect(threadId).toMatch(/marketing:cadence:2026-06-22/);
  });

  it("includes the pillar in the prompt text", () => {
    const d = new Date("2026-06-22T09:00:00.000Z");
    const { prompt, pillar } = buildSocialCadencePrompt(d);
    expect(prompt).toContain(pillar);
  });

  it("mentions hiring managers in prompt (job search goal)", () => {
    const d = new Date("2026-06-22T09:00:00.000Z");
    const { prompt } = buildSocialCadencePrompt(d);
    expect(prompt.toLowerCase()).toContain("hiring");
  });
});
