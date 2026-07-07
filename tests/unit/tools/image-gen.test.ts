/**
 * Unit tests for the image-generation primitive (Nano Banana).
 * Pure model selection + the generateContent call with an injected fetch — $0,
 * no live paid image API (cost gate #23).
 */
import { describe, it, expect } from "vitest";
import {
  selectImageModel,
  extractInlineImage,
  generateImage,
  ImageGenError,
  IMAGE_MODEL_DRAFT,
  IMAGE_MODEL_FINAL,
} from "../../../src/tools/image-gen.js";

describe("model ids — pinned to REAL Generative Language API model names", () => {
  // 2026-07-04 prod incident: IMAGE_MODEL_DRAFT.id was "gemini-3-1-flash-image"
  // (a typo'd/nonexistent id — dash instead of the real "2.5" family name). Every
  // live creative-department image request 404'd for days before this was caught
  // by reading prod logs, not by this test suite (all fetch calls were mocked).
  // Pin the literal strings so a typo here can never again go unnoticed until a
  // live call — verified against the real API on 2026-07-04 (HTTP 200, real
  // inline image data returned for both ids).
  it("DRAFT id is the real, live-verified Generative Language model", () => {
    expect(IMAGE_MODEL_DRAFT.id).toBe("gemini-2.5-flash-image");
  });
  it("FINAL id is the real, live-verified Generative Language model", () => {
    expect(IMAGE_MODEL_FINAL.id).toBe("gemini-3-pro-image");
  });
});

describe("selectImageModel — cost-disciplined, fail-cheap", () => {
  it("defaults to the cheap DRAFT model (no signal)", () => {
    expect(selectImageModel({}).id).toBe(IMAGE_MODEL_DRAFT.id);
    expect(selectImageModel({ intent: "a logo concept" }).tier).toBe("draft");
  });

  it("uses the Pro FINAL model only on explicit final=true", () => {
    expect(selectImageModel({ final: true }).id).toBe(IMAGE_MODEL_FINAL.id);
    expect(selectImageModel({ final: true }).tier).toBe("final");
  });

  it("uses Pro on an explicit 'final asset' intent phrase", () => {
    expect(selectImageModel({ intent: "make the final asset for the launch" }).tier).toBe("final");
    expect(selectImageModel({ intent: "publish-ready hero image" }).tier).toBe("final");
  });

  it("final=false overrides a final-sounding intent (never accidental Pro)", () => {
    expect(selectImageModel({ final: false, intent: "final asset please" }).tier).toBe("draft");
  });

  it("ambiguous wording stays on the cheap tier", () => {
    expect(selectImageModel({ intent: "something nice and finished-looking" }).tier).toBe("draft");
  });
});

describe("extractInlineImage — tolerant of camelCase and snake_case", () => {
  it("reads inlineData (camelCase)", () => {
    const r = extractInlineImage({ candidates: [{ content: { parts: [{ inlineData: { data: "AAAA", mimeType: "image/png" } }] } }] });
    expect(r).toEqual({ data: "AAAA", mimeType: "image/png" });
  });
  it("reads inline_data (snake_case) and defaults mime", () => {
    const r = extractInlineImage({ candidates: [{ content: { parts: [{ inline_data: { data: "BBBB" } }] } }] });
    expect(r).toEqual({ data: "BBBB", mimeType: "image/png" });
  });
  it("returns null when there is no image part", () => {
    expect(extractInlineImage({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })).toBeNull();
    expect(extractInlineImage({})).toBeNull();
  });
});

describe("generateImage — injected fetch, stage-tagged errors", () => {
  const okFetch = (body: unknown) => async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });

  it("returns the image + tier + usd on success", async () => {
    const img = await generateImage(
      "a cat",
      {},
      { apiKey: "test-key", fetchImpl: okFetch({ candidates: [{ content: { parts: [{ inlineData: { data: "ZZZZ", mimeType: "image/png" } }] } }] }) },
    );
    expect(img.base64).toBe("ZZZZ");
    expect(img.model).toBe(IMAGE_MODEL_DRAFT.id);
    expect(img.usd).toBe(IMAGE_MODEL_DRAFT.usdPerImage);
  });

  it("throws a config-stage error when the API key is absent", async () => {
    await expect(generateImage("x", {}, { apiKey: "", fetchImpl: okFetch({}) }))
      .rejects.toMatchObject({ stage: "config" });
  });

  it("throws a request-stage error on a non-2xx response", async () => {
    const bad = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
    await expect(generateImage("x", {}, { apiKey: "k", fetchImpl: bad }))
      .rejects.toBeInstanceOf(ImageGenError);
    await expect(generateImage("x", {}, { apiKey: "k", fetchImpl: bad }))
      .rejects.toMatchObject({ stage: "request" });
  });

  it("throws a parse-stage error when the response has no image", async () => {
    await expect(
      generateImage("x", {}, { apiKey: "k", fetchImpl: okFetch({ candidates: [{ content: { parts: [{ text: "no image" }] } }] }) }),
    ).rejects.toMatchObject({ stage: "parse" });
  });

  it("throws a request-stage error (fail-fast) when the API hangs past the timeout", async () => {
    // Prod symptom (T36/T37, 2026-07-07): image requests produced NO REPLY —
    // the generateContent fetch had no timeout, so a stalled call rode all the
    // way to the 180s turn timeout and the founder got silence. A bounded call
    // must convert a hang into a fast, stage-tagged error that surfaces (#19.5,
    // #22.3 fail-loud). Injected fetch never resolves; a short timeout must win.
    const hangForever = () => new Promise(() => {}) as never;
    await expect(
      generateImage("x", {}, { apiKey: "k", fetchImpl: hangForever, timeoutMs: 50 }),
    ).rejects.toMatchObject({ stage: "request" });
  });

  it("hits the Pro model + URL when final=true", async () => {
    let calledUrl = "";
    const spy = async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: "P", mimeType: "image/png" } }] } }] }) };
    };
    const img = await generateImage("hero", { final: true }, { apiKey: "k", fetchImpl: spy });
    expect(img.tier).toBe("final");
    expect(calledUrl).toContain(IMAGE_MODEL_FINAL.id);
  });
});
