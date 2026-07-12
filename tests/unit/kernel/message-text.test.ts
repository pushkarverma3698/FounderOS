/**
 * messageContentText — model content-shape drift guard.
 * LIVE FAILURE 2026-07-11/12 (turns d211fb74, 8c7e098f on build a2b4979):
 * gemini-flash-latest (rolling alias) started returning `content` as an array
 * of parts. Every kernel node extracted text with
 * `typeof content === "string" ? content : ""` (worker) or JSON.stringify
 * (planner/synthesizer), so honest, correct answers were thrown away and turns
 * died with "Worker did not finalize with JSON". The extraction must accept
 * both shapes — a model alias upgrade must never lobotomize the kernel.
 */

import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { messageContentText } from "../../../src/kernel/message-text.js";
import { makePlanNode, type KernelChatModel } from "../../../src/kernel/planner.js";
import { makeSynthesizeNode } from "../../../src/kernel/synthesizer.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

describe("messageContentText", () => {
  it("passes a plain string through untouched", () => {
    expect(messageContentText("hello")).toBe("hello");
  });

  it("joins text parts of an array content (gemini parts shape)", () => {
    expect(
      messageContentText([
        { type: "text", text: "The pending action is " },
        { type: "text", text: "the LinkedIn approval." },
      ]),
    ).toBe("The pending action is the LinkedIn approval.");
  });

  it("skips non-text parts and bare-string parts still contribute", () => {
    expect(
      messageContentText(["prefix ", { type: "tool_use", id: "x" }, { type: "text", text: "suffix" }]),
    ).toBe("prefix suffix");
  });

  it("returns empty string for empty arrays, null, undefined, and objects", () => {
    expect(messageContentText([])).toBe("");
    expect(messageContentText(null)).toBe("");
    expect(messageContentText(undefined)).toBe("");
    expect(messageContentText({ type: "text", text: "not-an-array" })).toBe("");
  });
});

// ── The two LLM nodes that also extracted string-only content ────────────────

function scriptedModel(content: unknown): KernelChatModel {
  return {
    invoke: async (_messages: BaseMessage[]) => new AIMessage({ content: content as never }),
  };
}

const CATALOG = [
  { id: "research" as const, description: "research", toolNames: ["search_web"], gatedToolNames: [] },
];

function planState(input: string): KernelStateType {
  return {
    turn: { id: "t1", chat_id: "1", received_at: new Date().toISOString(), raw_input: input },
    mission: { goal: "", status: "planning", plan: null, cursor: 0 },
    results: [],
    attempts: {},
    scratch: [],
    step_receipts: [],
    failure: null,
    reply: "",
    last_turn: null,
    history: [],
  } as unknown as KernelStateType;
}

describe("plan node accepts parts-array content (live regression)", () => {
  it("parses a direct-reply decision delivered as content parts", async () => {
    const plan = makePlanNode(
      scriptedModel([{ type: "text", text: '{"type":"reply","text":"Hi founder"}' }]),
      CATALOG,
    );
    const update = await plan(planState("hello"));
    expect(update.failure).toBeNull();
    expect(update.reply).toBe("Hi founder");
  });
});

describe("synthesize node accepts parts-array content (live regression)", () => {
  it("uses the joined text parts as the reply, not a JSON dump", async () => {
    const synthesize = makeSynthesizeNode(
      scriptedModel([{ type: "text", text: "Here is your summary." }]),
    );
    const state = {
      mission: { goal: "g", status: "synthesizing", plan: null, cursor: 1 },
      results: [],
    } as unknown as KernelStateType;
    const update = await synthesize(state);
    expect(update.reply).toBe("Here is your summary.");
    expect(update.reply).not.toContain('"type"');
  });

  it("system prompt sanity: scripted string content still works everywhere", async () => {
    const synthesize = makeSynthesizeNode(scriptedModel("plain string reply"));
    const state = {
      mission: { goal: "g", status: "synthesizing", plan: null, cursor: 1 },
      results: [],
    } as unknown as KernelStateType;
    const update = await synthesize(state);
    expect(update.reply).toBe("plain string reply");
  });
});

// Assert the prompt objects the nodes send are unchanged shape (guards against
// accidental signature drift while touching extraction).
describe("extraction change does not alter node call shape", () => {
  it("plan node still sends System + Human messages", async () => {
    let seen: BaseMessage[] = [];
    const model: KernelChatModel = {
      invoke: async (messages) => {
        seen = messages;
        return new AIMessage('{"type":"reply","text":"ok"}');
      },
    };
    await makePlanNode(model, CATALOG)(planState("hi"));
    expect(seen[0]).toBeInstanceOf(SystemMessage);
    expect(seen.at(-1)).toBeInstanceOf(HumanMessage);
  });
});
