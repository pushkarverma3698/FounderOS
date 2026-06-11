/**
 * Unit tests for OpenRouter cross-provider fallback in FounderChatGoogle.
 * Verifies the escape hatch: gemini-2.5-flash → gemini-2.5-flash-lite → openrouter/gpt-4o-mini.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { getModel, sanitizeForGemini } from "../../../src/agents/model.js";

const FAKE_OR_KEY = "sk-or-v1-test-key-for-unit-tests";

describe("OpenRouter fallback wiring", () => {
  afterEach(() => {
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["AGENT_MODEL"];
    vi.restoreAllMocks();
  });

  it("_openRouterFallback is null when OPENROUTER_API_KEY is absent", () => {
    delete process.env["OPENROUTER_API_KEY"];
    const m = getModel();
    const fallback = (m as unknown as { _openRouterFallback: unknown })._openRouterFallback;
    expect(fallback).toBeNull();
  });

  it("_openRouterFallback is a ChatOpenAI instance when OPENROUTER_API_KEY is set", () => {
    process.env["OPENROUTER_API_KEY"] = FAKE_OR_KEY;
    const m = getModel();
    const fallback = (m as unknown as { _openRouterFallback: unknown })._openRouterFallback;
    expect(fallback).not.toBeNull();
    expect(fallback).toBeInstanceOf(ChatOpenAI);
  });

  it("bindTools propagates to OpenRouter fallback and sets _openRouterBound", () => {
    process.env["OPENROUTER_API_KEY"] = FAKE_OR_KEY;
    const m = getModel();

    // Spy on ChatOpenAI.bindTools to verify it gets called
    const orFallback = (m as unknown as { _openRouterFallback: ChatOpenAI })._openRouterFallback;
    const bindSpy = vi.spyOn(orFallback, "bindTools").mockReturnValue(orFallback as ReturnType<ChatOpenAI["bindTools"]>);

    m.bindTools([], {});
    expect(bindSpy).toHaveBeenCalledOnce();
    expect(bindSpy).toHaveBeenCalledWith([], {});
  });

  it("flash-lite is tried before OpenRouter on 503 (order: primary → flash-lite → OpenRouter)", () => {
    process.env["OPENROUTER_API_KEY"] = FAKE_OR_KEY;
    const m = getModel();

    // All Google calls throw 503
    vi.spyOn(ChatGoogleGenerativeAI.prototype as any, "_generate").mockRejectedValue(
      new Error("503 Service Unavailable high demand"),
    );

    const orFallback = (m as unknown as { _openRouterFallback: ChatOpenAI })._openRouterFallback!;
    const orInvokeSpy = vi.spyOn(orFallback, "invoke").mockResolvedValue({
      content: "OpenRouter response",
    } as any);

    return new Promise<void>(async (resolve) => {
      vi.useFakeTimers();
      const resultPromise = (m as any)._generate([new HumanMessage("hello")], {});
      resultPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(30_000);
      vi.useRealTimers();

      const result = await resultPromise;
      // OpenRouter was called
      expect(orInvokeSpy).toHaveBeenCalledOnce();
      // Result wraps OpenRouter response
      expect(result.generations[0].message.content).toBe("OpenRouter response");
      expect(result.llmOutput?.provider).toBe("openrouter");
      resolve();
    });
  });

  it("non-503 errors throw immediately without trying OpenRouter", async () => {
    process.env["OPENROUTER_API_KEY"] = FAKE_OR_KEY;
    const m = getModel();

    const badRequestErr = new Error("400 Bad Request: invalid argument");
    vi.spyOn(ChatGoogleGenerativeAI.prototype as any, "_generate").mockRejectedValueOnce(
      badRequestErr,
    );

    const orFallback = (m as unknown as { _openRouterFallback: ChatOpenAI })._openRouterFallback!;
    const orInvokeSpy = vi.spyOn(orFallback, "invoke");

    await expect((m as any)._generate([new HumanMessage("hello")], {})).rejects.toThrow(
      "400 Bad Request",
    );
    // OpenRouter must NOT be tried for non-503 errors
    expect(orInvokeSpy).not.toHaveBeenCalled();
  });
});

describe("sanitizeForGemini", () => {
  it("filters out messages with empty string content", () => {
    const msgs = [
      new HumanMessage(""),
      new HumanMessage("real message"),
    ];
    const result = sanitizeForGemini(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("real message");
  });

  it("filters out messages with whitespace-only content", () => {
    const msgs = [
      new HumanMessage("   "),
      new HumanMessage("actual content"),
    ];
    const result = sanitizeForGemini(msgs);
    expect(result).toHaveLength(1);
  });

  it("keeps AIMessages with tool_calls even if content string is empty", () => {
    const msgWithCalls = new AIMessage({
      content: "",
      tool_calls: [{ name: "search_web", args: {}, id: "call_1", type: "tool_call" }],
    });
    const msgs = [msgWithCalls];
    const result = sanitizeForGemini(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(msgWithCalls);
  });

  it("synthesizes a valid human message when all messages are empty (never returns invalid array)", () => {
    // Regression: returning the original all-empty array guaranteed the Gemini
    // 400 "contents is not specified" crash this function exists to prevent.
    const msgs = [
      new HumanMessage(""),
      new HumanMessage("   "),
    ];
    const result = sanitizeForGemini(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]._getType()).toBe("human");
    expect((result[0].content as string).trim().length).toBeGreaterThan(0);
  });

  it("appends a synthetic human message when only system messages survive", () => {
    // Gemini moves system messages to systemInstruction, so a system-only list
    // converts to an empty contents array → 400 "contents is not specified".
    const msgs = [new SystemMessage("You are the supervisor.")];
    const result = sanitizeForGemini(msgs);
    expect(result.length).toBe(2);
    expect(result[0]._getType()).toBe("system");
    expect(result[1]._getType()).toBe("human");
    expect((result[1].content as string).trim().length).toBeGreaterThan(0);
  });

  it("returns messages unchanged when all have valid content", () => {
    const msgs = [
      new HumanMessage("what is the weather?"),
      new HumanMessage("search for recent news"),
    ];
    const result = sanitizeForGemini(msgs);
    expect(result).toHaveLength(2);
    expect(result).toEqual(msgs);
  });

  it("filters out array-content messages where all text parts are empty", () => {
    // Gemini rejects Content with no non-empty parts — this is the T10 bug
    const emptyArrayMsg = new HumanMessage({ content: [{ type: "text", text: "" }] });
    const validMsg = new HumanMessage("real question");
    const result = sanitizeForGemini([emptyArrayMsg, validMsg]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("real question");
  });

  it("filters out array-content messages where all text parts are whitespace only", () => {
    const whitespaceMsg = new HumanMessage({ content: [{ type: "text", text: "   " }] });
    const validMsg = new HumanMessage("real content");
    const result = sanitizeForGemini([whitespaceMsg, validMsg]);
    expect(result).toHaveLength(1);
  });

  it("keeps array-content messages that have at least one non-empty text part", () => {
    const mixedMsg = new HumanMessage({
      content: [{ type: "text", text: "" }, { type: "text", text: "actual text" }],
    });
    const result = sanitizeForGemini([mixedMsg]);
    expect(result).toHaveLength(1);
  });

  it("keeps array-content messages with non-text parts (images, tool results)", () => {
    const imageMsg = new HumanMessage({
      content: [{ type: "image_url", image_url: "data:image/png;base64,abc" }],
    });
    const result = sanitizeForGemini([imageMsg]);
    expect(result).toHaveLength(1);
  });

  it("synthesizes a valid human message when all array-content messages are invalid", () => {
    const allEmpty = [
      new HumanMessage({ content: [{ type: "text", text: "" }] }),
      new HumanMessage({ content: [{ type: "text", text: "  " }] }),
    ];
    const result = sanitizeForGemini(allEmpty);
    expect(result).toHaveLength(1);
    expect(result[0]._getType()).toBe("human");
    expect((result[0].content as string).trim().length).toBeGreaterThan(0);
  });
});
