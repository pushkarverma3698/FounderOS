/**
 * GEMINI_THINKING_LEVEL — the one parse behind every google-genai model.
 *
 * 2026-09-28 audit §1: ChatGoogleGenerativeAI was built without thinkingConfig,
 * so Gemini 3.x ran its default dynamic thinking on every call — 473-615 thought
 * tokens and about 3 s per planner call, none of it visible in the reply or the
 * cost ledger. LOW measured 0 thought tokens on the same prompt.
 *
 * The model factory, the kernel's judge and the QA battery's content judge all
 * read the level through this helper, so they cannot drift apart. A value
 * outside the list is refused: boot builds the models (src/index.ts getKernel),
 * so a typo stops the deploy instead of quietly meaning "LOW".
 */

import { describe, it, expect } from "vitest";
import { geminiThinkingConfig, parseGeminiThinkingLevel } from "../../../src/core/gemini-thinking.js";

describe("parseGeminiThinkingLevel", () => {
  it("defaults to LOW when unset or blank", () => {
    expect(parseGeminiThinkingLevel(undefined)).toBe("LOW");
    expect(parseGeminiThinkingLevel("")).toBe("LOW");
    expect(parseGeminiThinkingLevel("   ")).toBe("LOW");
  });

  it("reads the level case-insensitively", () => {
    expect(parseGeminiThinkingLevel("low")).toBe("LOW");
    expect(parseGeminiThinkingLevel(" Medium ")).toBe("MEDIUM");
    expect(parseGeminiThinkingLevel("HIGH")).toBe("HIGH");
    expect(parseGeminiThinkingLevel("default")).toBe("DEFAULT");
  });

  it("refuses a value outside the list, naming the ones it accepts", () => {
    // MINIMAL is a real API level (the audit measured it) but not one the
    // installed @langchain/google-genai types allow — so it is refused here
    // rather than passed through a cast.
    expect(() => parseGeminiThinkingLevel("MINIMAL")).toThrow(/GEMINI_THINKING_LEVEL.*LOW, MEDIUM, HIGH, DEFAULT/);
    expect(() => parseGeminiThinkingLevel("off")).toThrow(/GEMINI_THINKING_LEVEL/);
  });
});

describe("geminiThinkingConfig", () => {
  it("asks for LOW thinking when nothing is configured", () => {
    expect(geminiThinkingConfig({})).toEqual({ thinkingLevel: "LOW" });
  });

  it("passes MEDIUM and HIGH through", () => {
    expect(geminiThinkingConfig({ GEMINI_THINKING_LEVEL: "MEDIUM" })).toEqual({ thinkingLevel: "MEDIUM" });
    expect(geminiThinkingConfig({ GEMINI_THINKING_LEVEL: "HIGH" })).toEqual({ thinkingLevel: "HIGH" });
  });

  it("returns undefined for DEFAULT, so the constructor omits thinkingConfig entirely", () => {
    // DEFAULT is the rollback lever: Google's own dynamic thinking, which is
    // what prod ran before this change.
    expect(geminiThinkingConfig({ GEMINI_THINKING_LEVEL: "DEFAULT" })).toBeUndefined();
  });

  it("reads process.env at call time when no env is passed", () => {
    const saved = process.env["GEMINI_THINKING_LEVEL"];
    try {
      process.env["GEMINI_THINKING_LEVEL"] = "HIGH";
      expect(geminiThinkingConfig()).toEqual({ thinkingLevel: "HIGH" });
    } finally {
      if (saved === undefined) delete process.env["GEMINI_THINKING_LEVEL"];
      else process.env["GEMINI_THINKING_LEVEL"] = saved;
    }
  });
});
