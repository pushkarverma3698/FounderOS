/**
 * Unit tests for the vision stage. Gemini is FULLY MOCKED — CLAUDE.md's
 * zero-paid-calls rule makes a test that reaches a real model a bug, not a
 * slow test.
 *
 * The behaviours under test are the ones that cost money to get wrong:
 * an unreadable screenshot must never read as a pass, and a parse failure must
 * be a failure rather than an empty clean verdict.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { geminiGenerateMock } = vi.hoisted(() => ({ geminiGenerateMock: vi.fn() }));

vi.mock("../../../../src/tools/gemini-rest.js", () => ({
  geminiGenerate: geminiGenerateMock,
}));

import { parseVisionVerdict, judgeScreenshot, MAX_VISION_IMAGES } from "../../../../src/tools/browser/ui-vision.js";

const PNG = Buffer.from("fake-png-bytes");

describe("parseVisionVerdict", () => {
  it("parses a clean verdict", () => {
    const v = parseVisionVerdict('{"readable":true,"ok":true,"summary":"The page looks finished.","defects":[]}');
    expect(v).toMatchObject({ readable: true, ok: true, defects: [] });
  });

  it("strips a ```json fence", () => {
    const v = parseVisionVerdict('```json\n{"readable":true,"ok":true,"summary":"Fine.","defects":[]}\n```');
    expect(v?.ok).toBe(true);
  });

  it("forces ok=false when the screenshot is unreadable, even if the model said ok=true", () => {
    // The model contradicting itself must not become a pass.
    const v = parseVisionVerdict('{"readable":false,"ok":true,"summary":"Blank image.","defects":[]}');
    expect(v).toMatchObject({ readable: false, ok: false });
  });

  it("forces ok=false when a high-severity defect is reported alongside ok=true", () => {
    const v = parseVisionVerdict(
      '{"readable":true,"ok":true,"summary":"Mostly fine.","defects":[{"severity":"high","area":"hero","description":"Headline overlaps the image."}]}',
    );
    expect(v?.ok).toBe(false);
  });

  it("keeps a medium-severity defect non-blocking", () => {
    const v = parseVisionVerdict(
      '{"readable":true,"ok":true,"summary":"Minor flaw.","defects":[{"severity":"medium","area":"footer","description":"Slight misalignment."}]}',
    );
    expect(v?.ok).toBe(true);
    expect(v?.defects).toHaveLength(1);
  });

  it("drops a malformed defect entry rather than trusting an invalid severity", () => {
    const v = parseVisionVerdict(
      '{"readable":true,"ok":true,"summary":"x","defects":[{"severity":"catastrophic","area":"hero","description":"?"},{"severity":"low","area":"nav","description":"ok"}]}',
    );
    expect(v?.defects).toHaveLength(1);
    expect(v?.defects[0]?.severity).toBe("low");
  });

  it("returns null for unparseable output and for a missing readable flag", () => {
    expect(parseVisionVerdict("I could not analyse that image.")).toBeNull();
    expect(parseVisionVerdict('{"ok":true,"defects":[]}')).toBeNull();
  });
});

describe("judgeScreenshot", () => {
  const origKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];

  beforeEach(() => {
    geminiGenerateMock.mockReset();
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "test-key";
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    else process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = origKey;
  });

  it("returns a verdict tagged with its target and viewport", async () => {
    geminiGenerateMock.mockResolvedValue({
      text: '{"readable":true,"ok":true,"summary":"Looks finished.","defects":[]}',
    });
    const res = await judgeScreenshot(PNG, { target: "neon", viewport: "desktop" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.verdict).toMatchObject({ target: "neon", viewport: "desktop", ok: true });
    }
  });

  it("sends the screenshot as inline PNG data and forces JSON output", async () => {
    geminiGenerateMock.mockResolvedValue({ text: '{"readable":true,"ok":true,"summary":"ok","defects":[]}' });
    await judgeScreenshot(PNG, { target: "neon", viewport: "mobile" });

    const call = geminiGenerateMock.mock.calls[0]?.[0];
    expect(call.responseMimeType).toBe("application/json");
    const inline = call.parts.find((p: { inlineData?: unknown }) => p.inlineData);
    expect(inline.inlineData.mimeType).toBe("image/png");
    expect(inline.inlineData.data).toBe(PNG.toString("base64"));
  });

  it("passes the page's stated purpose into the prompt", async () => {
    geminiGenerateMock.mockResolvedValue({ text: '{"readable":true,"ok":true,"summary":"ok","defects":[]}' });
    await judgeScreenshot(PNG, { target: "neon", viewport: "desktop", purpose: "a finished client launch page" });
    const text = geminiGenerateMock.mock.calls[0]?.[0].parts[0].text as string;
    expect(text).toContain("a finished client launch page");
  });

  it("SOFT FAILURE: a 200 with unparseable prose is a failure, not an empty pass", async () => {
    // The mandatory soft-failure path from docs/rules/TOOL-STANDARDS.md §2 —
    // the model returning something that is not the contract must never render
    // as "vision looked and found nothing wrong".
    geminiGenerateMock.mockResolvedValue({ text: "Sure! The page looks great to me." });
    const res = await judgeScreenshot(PNG, { target: "neon", viewport: "desktop" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("unparseable");
  });

  it("returns a typed failure when the transport throws, never rethrows", async () => {
    geminiGenerateMock.mockRejectedValue(new Error("Gemini HTTP 503"));
    const res = await judgeScreenshot(PNG, { target: "neon", viewport: "desktop" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("503");
  });

  it("refuses to run, and says why, when no API key is configured", async () => {
    delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    const res = await judgeScreenshot(PNG, { target: "neon", viewport: "desktop" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(geminiGenerateMock).not.toHaveBeenCalled();
  });

  it("caps paid image review at a hard, documented ceiling", () => {
    expect(MAX_VISION_IMAGES).toBe(8);
  });
});
