/**
 * Unit tests — media tool pure functions (vision / transcription / TTS / gateway).
 * The live paths are covered by the verification-first E2E runs (see
 * docs/FEATURE_TEST_REPORT.md); these tests lock the parsing contracts and the
 * anti-hallucination floor so the class of bug can never silently return.
 */
import { describe, it, expect } from "vitest";
import { parseVisionResponse } from "../../../src/tools/vision.js";
import { parseTranscriptionResponse } from "../../../src/tools/transcription.js";
import { parsePcmRate } from "../../../src/tools/tts.js";
import { wantsSpeech } from "../../../src/gateway/media.js";

describe("parseVisionResponse", () => {
  it("parses a valid translation payload", () => {
    const r = parseVisionResponse(
      '{"hasText":true,"sourceLanguage":"Dutch","originalText":"Verboden toegang.","englishText":"No entry."}',
    );
    expect(r).toEqual({
      hasText: true,
      sourceLanguage: "Dutch",
      originalText: "Verboden toegang.",
      englishText: "No entry.",
    });
  });

  it("strips markdown code fences before parsing", () => {
    const r = parseVisionResponse('```json\n{"hasText":false,"sourceLanguage":"","originalText":"","englishText":""}\n```');
    expect(r?.hasText).toBe(false);
  });

  it("returns null for invalid JSON", () => {
    expect(parseVisionResponse("not json at all")).toBeNull();
  });

  it("returns null when hasText is missing", () => {
    expect(parseVisionResponse('{"sourceLanguage":"Dutch"}')).toBeNull();
  });

  it("defaults non-string fields to empty strings", () => {
    const r = parseVisionResponse('{"hasText":true,"sourceLanguage":42,"originalText":null,"englishText":"ok"}');
    expect(r).toEqual({ hasText: true, sourceLanguage: "", originalText: "", englishText: "ok" });
  });
});

describe("parseTranscriptionResponse", () => {
  it("parses a valid Dutch transcription", () => {
    const r = parseTranscriptionResponse(
      '{"hasSpeech":true,"detectedLanguage":"Dutch","transcript":"Stuur een update.","englishText":"Send an update."}',
    );
    expect(r?.hasSpeech).toBe(true);
    expect(r?.detectedLanguage).toBe("Dutch");
  });

  it("ANTI-HALLUCINATION: forces hasSpeech=false when transcript is near-empty even if model claims speech", () => {
    const r = parseTranscriptionResponse('{"hasSpeech":true,"detectedLanguage":"English","transcript":"a","englishText":"a"}');
    expect(r?.hasSpeech).toBe(false);
  });

  it("ANTI-HALLUCINATION: forces hasSpeech=false when englishText is empty", () => {
    const r = parseTranscriptionResponse('{"hasSpeech":true,"detectedLanguage":"English","transcript":"hello there","englishText":""}');
    expect(r?.hasSpeech).toBe(false);
  });

  it("respects model-declared no-speech", () => {
    const r = parseTranscriptionResponse('{"hasSpeech":false,"detectedLanguage":"","transcript":"","englishText":""}');
    expect(r?.hasSpeech).toBe(false);
  });

  it("returns null for invalid JSON", () => {
    expect(parseTranscriptionResponse("garbage")).toBeNull();
  });
});

describe("parsePcmRate", () => {
  it("extracts the rate from a Gemini TTS mime type", () => {
    expect(parsePcmRate("audio/L16;codec=pcm;rate=24000")).toBe(24000);
  });

  it("falls back when no rate present", () => {
    expect(parsePcmRate("audio/L16")).toBe(24000);
    expect(parsePcmRate("audio/L16", 16000)).toBe(16000);
  });
});

describe("wantsSpeech", () => {
  it.each([
    ["convert this to english and speak it", true],
    ["read it to me", true],
    ["what does this say? use voice", true],
    ["translate this", false],
    ["", false],
    ["respeak", false], // word-boundary: no substring match
  ])("%s → %s", (caption, expected) => {
    expect(wantsSpeech(caption)).toBe(expected);
  });
});
