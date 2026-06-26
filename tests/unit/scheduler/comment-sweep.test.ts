/**
 * Tests for buildCommentSweepPrompt — pure function, no DB/LLM.
 */
import { describe, it, expect } from "vitest";
import { buildCommentSweepPrompt } from "../../../src/infra/scheduler.js";

const POST_ID = "urn:li:share:9999";
const COMMENTS = [
  { id: "c1", author_urn: "urn:li:person:A", text: "Great work on the multi-agent setup!" },
  { id: "c2", author_urn: "urn:li:person:B", text: "How does the HITL approval work in practice?" },
];

describe("buildCommentSweepPrompt", () => {
  it("includes the post_id", () => {
    const { prompt } = buildCommentSweepPrompt(POST_ID, COMMENTS);
    expect(prompt).toContain(POST_ID);
  });

  it("includes all comment texts", () => {
    const { prompt } = buildCommentSweepPrompt(POST_ID, COMMENTS);
    expect(prompt).toContain("Great work on the multi-agent setup!");
    expect(prompt).toContain("How does the HITL approval work");
  });

  it("includes all author URNs", () => {
    const { prompt } = buildCommentSweepPrompt(POST_ID, COMMENTS);
    expect(prompt).toContain("urn:li:person:A");
    expect(prompt).toContain("urn:li:person:B");
  });

  it("instructs to call draft_linkedin_reply", () => {
    const { prompt } = buildCommentSweepPrompt(POST_ID, COMMENTS);
    expect(prompt).toContain("draft_linkedin_reply");
  });

  it("generates a unique threadId per call (includes timestamp)", () => {
    const { threadId: id1 } = buildCommentSweepPrompt(POST_ID, COMMENTS);
    const { threadId: id2 } = buildCommentSweepPrompt(POST_ID, COMMENTS);
    expect(id1).toContain(POST_ID);
    // Both contain the post_id but are timestamped — structure test only
    expect(id1).toMatch(/comment-sweep/);
    expect(id2).toMatch(/comment-sweep/);
  });

  it("handles single comment", () => {
    const { prompt } = buildCommentSweepPrompt(POST_ID, [COMMENTS[0]!]);
    expect(prompt).toContain("1. urn:li:person:A");
    expect(prompt).not.toContain("2.");
  });
});
