/**
 * TDD — distilling Claude Code session transcripts.
 *
 * The founder's instruction was explicit: no raw transcripts. `~/.claude/projects/`
 * holds 358 MB, 213 MB of it for this repo alone, and the overwhelming majority is
 * tool-call payloads and file dumps — my own output echoing files that are already
 * in git. Embedding that would bury the 155 curated brain chunks under noise and
 * make retrieval measurably worse.
 *
 * So the parser's job is subtractive: keep what a person said and what was concluded,
 * drop the machinery. These tests pin the subtraction, because a parser that silently
 * starts keeping tool blobs would look identical from the outside until the brain
 * was already polluted.
 */

import { describe, it, expect } from "vitest";
import { distillSession, renderSession } from "../../../src/lib/claude-transcript.js";

/** One JSON object per line, exactly as Claude Code writes it. */
function jsonl(...objects: unknown[]): string {
  return objects.map((o) => JSON.stringify(o)).join("\n");
}

const USER_TURN = {
  type: "user",
  timestamp: "2026-08-07T10:00:00.000Z",
  message: { role: "user", content: "Why does the conversations tier return nothing?" },
};

const ASSISTANT_TURN = {
  type: "assistant",
  timestamp: "2026-08-07T10:01:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me check whether a branch exists for it." },
      { type: "text", text: "The enum advertises the tier but no branch implements it." },
    ],
  },
};

describe("distillSession — keeps meaning, drops machinery", () => {
  it("keeps user prose and assistant text", () => {
    const session = distillSession(jsonl(USER_TURN, ASSISTANT_TURN), "sess-1");

    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]?.role).toBe("user");
    expect(session.turns[0]?.text).toContain("conversations tier");
    expect(session.turns[1]?.text).toContain("no branch implements it");
  });

  it("drops thinking blocks — they are reasoning, not conclusions", () => {
    const session = distillSession(jsonl(ASSISTANT_TURN), "sess-1");

    expect(session.turns[0]?.text).not.toContain("Let me check whether");
  });

  it("drops tool_use and tool_result blocks entirely", () => {
    const withTools = jsonl(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Bash", input: { command: "cat src/db/schema.ts" } },
            { type: "text", text: "Twenty-six tables." },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", content: "export const hitlApprovals = agentsSchema.table(..." },
          ],
        },
      },
    );

    const session = distillSession(withTools, "sess-1");
    const all = session.turns.map((t) => t.text).join(" ");

    expect(all).toContain("Twenty-six tables");
    expect(all).not.toContain("cat src/db/schema.ts");
    expect(all).not.toContain("hitlApprovals");
  });

  it("ignores queue-operation, attachment, system and last-prompt lines", () => {
    const noise = jsonl(
      { type: "queue-operation", operation: "enqueue", content: "queued prompt text" },
      { type: "attachment", content: "a pasted file" },
      { type: "system", content: "system reminder text" },
      { type: "last-prompt", content: "duplicate of the prompt" },
      USER_TURN,
    );

    const session = distillSession(noise, "sess-1");

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.role).toBe("user");
  });

  it("survives a truncated final line — a live session is always mid-write", () => {
    const truncated = `${jsonl(USER_TURN)}\n{"type":"assistant","message":{"role":"assi`;

    const session = distillSession(truncated, "sess-1");

    expect(session.turns).toHaveLength(1);
    expect(session.malformedLines).toBe(1);
  });

  it("drops slash-command output — that is the machine talking, not the founder", () => {
    const withCommandOutput = jsonl(
      {
        type: "user",
        message: {
          role: "user",
          content: "<local-command-stdout>Compacted successfully</local-command-stdout>",
        },
      },
      USER_TURN,
    );

    const session = distillSession(withCommandOutput, "sess-1");

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.text).toContain("conversations tier");
  });

  it("truncates a paste without dropping the turn it was pasted into", () => {
    const paste = jsonl({
      type: "user",
      message: { role: "user", content: `Look at this file: ${"x".repeat(50_000)}` },
    });

    const session = distillSession(paste, "sess-1");

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.text).toContain("Look at this file");
    expect(session.turns[0]?.text).toContain("[truncated]");
    expect(session.turns[0]?.text.length).toBeLessThan(4_100);
  });

  it("reports an empty session as empty rather than pretending it parsed", () => {
    const session = distillSession("", "sess-1");

    expect(session.turns).toHaveLength(0);
    expect(session.lastActivity).toBeNull();
  });

  it("carries the last activity timestamp so ingestion can skip unchanged sessions", () => {
    const session = distillSession(jsonl(USER_TURN, ASSISTANT_TURN), "sess-1");

    expect(session.lastActivity?.toISOString()).toBe("2026-08-07T10:01:00.000Z");
  });
});

describe("renderSession — the text that actually gets embedded", () => {
  it("labels speakers so a chunk is attributable out of context", () => {
    const rendered = renderSession(distillSession(jsonl(USER_TURN, ASSISTANT_TURN), "sess-1"));

    expect(rendered).toContain("FOUNDER:");
    expect(rendered).toContain("CLAUDE:");
  });

  it("returns an empty string for a session with no turns, never a bare header", () => {
    expect(renderSession(distillSession("", "sess-1"))).toBe("");
  });
});
