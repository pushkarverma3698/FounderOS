/**
 * Unit tests for scheduler pure helper functions.
 * These test the context-text builder without touching cron, DB, or LLM.
 */

import { describe, it, expect } from "vitest";
import { buildContextText } from "../../../src/infra/scheduler.js";

describe("buildContextText", () => {
  it("formats a flat string value", () => {
    const ctx = { focus: "close Acme deal" };
    const text = buildContextText(ctx);
    expect(text).toContain("focus: close Acme deal");
  });

  it("formats an array value as comma-separated", () => {
    const ctx = { active_clients: ["Acme Corp", "Beta Ltd"] };
    const text = buildContextText(ctx);
    expect(text).toContain("active_clients: Acme Corp, Beta Ltd");
  });

  it("renders empty array as 'none'", () => {
    const ctx = { active_clients: [] as string[] };
    const text = buildContextText(ctx);
    expect(text).toContain("active_clients: none");
  });

  it("skips the last_updated key", () => {
    const ctx = { focus: "ship phase D", last_updated: "2026-06-01T00:00:00Z" };
    const text = buildContextText(ctx);
    expect(text).not.toContain("last_updated");
    expect(text).toContain("focus:");
  });

  it("returns default message when context is empty", () => {
    const text = buildContextText({});
    expect(text).toContain("No context stored yet");
    expect(text).toContain("active_clients: none");
  });

  it("returns default message when context only has last_updated", () => {
    const text = buildContextText({ last_updated: "2026-06-01T00:00:00Z" });
    expect(text).toContain("No context stored yet");
  });

  it("formats multiple keys each on its own line", () => {
    const ctx = { active_clients: ["Acme"], current_priorities: ["ship"] };
    const lines = buildContextText(ctx).split("\n");
    expect(lines).toHaveLength(2);
  });
});
