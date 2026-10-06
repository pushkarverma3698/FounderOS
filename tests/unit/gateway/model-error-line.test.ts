/**
 * P2-6 (docs/plans/2026-10-04-telegram-ux-audit.md, F21): on 09-29 three turns in a
 * row answered with a Gemini 400 "exclusiveMinimum" stack, printed twice per message.
 * A model-API rejection reaches the founder as ONE line, once, with no stack.
 */

import { describe, it, expect } from "vitest";
import type { Context } from "grammy";
import type { KernelStateType } from "../../../src/kernel/index.js";
import { modelErrorLine } from "../../../src/gateway/model-error-line.js";
import { replyForError } from "../../../src/gateway/error-reply.js";
import { renderFailureCard } from "../../../src/gateway/failure-card.js";

const GEMINI_SCHEMA_400 =
  "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent: " +
  "[400 Bad Request] * GenerateContentRequest.tools[0].function_declarations[12].parameters.properties[limit]: " +
  "Unknown name \"exclusiveMinimum\": Cannot find field.\n    at GoogleGenerativeAI.fetch (/opt/founderos/node_modules/x.js:1:2)";

describe("modelErrorLine", () => {
  it("turns the Gemini schema 400 into one plain line with no stack and no field names", () => {
    const line = modelErrorLine(GEMINI_SCHEMA_400);
    expect(line).toBe("The model refused that request (schema). Retry?");
    expect(line).not.toContain("\n");
  });

  it("names a 400 that is not about the schema as a bad request", () => {
    const line = modelErrorLine('400 {"error":{"message":"Invalid value for messages","type":"invalid_request_error"}}');
    expect(line).toBe("The model refused that request (bad request). Retry?");
  });

  it("returns null for errors that are not a model-API rejection", () => {
    expect(modelErrorLine("Could not read from repository: select a branch and update it")).toBeNull();
    expect(modelErrorLine("connect ECONNREFUSED 127.0.0.1:5432")).toBeNull();
    expect(modelErrorLine("relation \"agents.job_applications\" does not exist")).toBeNull();
    expect(modelErrorLine("")).toBeNull();
  });

  it("returns null for a rate limit, which has its own wording and auto-retry", () => {
    expect(modelErrorLine("[429 Too Many Requests] Resource has been exhausted (e.g. check quota).")).toBeNull();
  });
});

describe("the line reaches the founder once", () => {
  it("replyForError sends the one line, not the raw stack", async () => {
    const replies: string[] = [];
    const ctx = { reply: async (text: string) => void replies.push(text) } as unknown as Context;
    await replyForError(ctx, new Error(GEMINI_SCHEMA_400));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("The model refused that request (schema). Retry?");
    expect(replies[0]).not.toContain("exclusiveMinimum");
    expect(replies[0]).not.toContain("GoogleGenerativeAI");
    expect(replies[0]!.split("The model refused").length - 1).toBe(1);
  });

  it("the failure card's Why line is the one line for a model-stage failure", () => {
    const state = {
      turn: { id: "t", chat_id: "1", received_at: "", raw_input: "list my emails" },
      mission: { goal: "list my emails", status: "failed", cursor: 0, plan: null },
      results: [],
      failure: {
        step_id: "s1",
        stage: "model",
        component: "kernel/worker:comms",
        message: `Worker model call failed: ${GEMINI_SCHEMA_400.replace(/\s+/g, " ")}`,
        retryable: true,
      },
      reply: "",
    } as unknown as KernelStateType;
    const html = renderFailureCard(state, { retry: true });
    const visible = html.split("<blockquote")[0]!;
    expect(visible).toContain("<b>Why:</b> The model refused that request (schema). Retry?");
    expect(visible).not.toContain("exclusiveMinimum");
  });

  it("a non-model failure keeps its own reason", () => {
    const state = {
      turn: { id: "t", chat_id: "1", received_at: "", raw_input: "x" },
      mission: { goal: "x", status: "failed", cursor: 0, plan: null },
      results: [],
      failure: { step_id: "s1", stage: "validation", component: "kernel/worker", message: "missing field sender", retryable: true },
      reply: "",
    } as unknown as KernelStateType;
    expect(renderFailureCard(state, { retry: true })).toContain("<b>Why:</b> missing field sender");
  });
});
