/**
 * v3 status-class error taxonomy — httpStatusOf / is503Error / isModelFallbackError.
 * Pins the two incidents that motivated the change:
 *  - audit Run B: a 403 must NOT classify as retriable load,
 *  - 2026-06-27: a retired model's 404 MUST engage the model fallback chain.
 */

import { describe, it, expect } from "vitest";
import { httpStatusOf, is503Error, isModelFallbackError } from "../../../src/agents/model.js";

function sdkError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe("httpStatusOf", () => {
  it("reads structured status props (OpenAI/Anthropic SDK shape)", () => {
    expect(httpStatusOf(sdkError(429, "Rate limited"))).toBe(429);
    expect(httpStatusOf({ response: { status: 502 } })).toBe(502);
    expect(httpStatusOf({ error: { status: 404 } })).toBe(404);
  });

  it("reads the leading-NNN message convention", () => {
    expect(httpStatusOf(new Error("403 Host not in allowlist: openrouter.ai"))).toBe(403);
    expect(httpStatusOf(new Error("404 No endpoints found for google/gemini-2.5-flash:free"))).toBe(404);
  });

  it("returns null for transport errors and non-status text", () => {
    expect(httpStatusOf(new Error("fetch failed"))).toBeNull();
    expect(httpStatusOf(new Error("port 5001 already in use"))).toBeNull();
    expect(httpStatusOf(null)).toBeNull();
  });

  it("recurses into cause", () => {
    expect(httpStatusOf(new Error("wrapped", { cause: sdkError(503, "boom") }))).toBe(503);
  });
});

describe("is503Error (retriable-by-class)", () => {
  it("5xx / 429 / 408 by real status → retriable", () => {
    expect(is503Error(sdkError(503, "unavailable"))).toBe(true);
    expect(is503Error(sdkError(429, "slow down"))).toBe(true);
    expect(is503Error(sdkError(408, "timeout"))).toBe(true);
  });

  it("4xx auth/permission/not-found → NOT retriable (audit Run B)", () => {
    expect(is503Error(new Error("403 Host not in allowlist: openrouter.ai"))).toBe(false);
    expect(is503Error(sdkError(401, "invalid api key"))).toBe(false);
    expect(is503Error(sdkError(404, "model not found"))).toBe(false);
  });

  it("transport-level errors by code → retriable", () => {
    const err = new Error("request failed") as Error & { code: string };
    err.code = "ECONNRESET";
    expect(is503Error(err)).toBe(true);
  });

  it("preserves the historical message idioms", () => {
    expect(is503Error(new Error("503 Service Unavailable high demand"))).toBe(true);
    expect(is503Error(new Error("read ECONNRESET"))).toBe(true);
    expect(is503Error(new Error("HTTP 500 Internal Server Error"))).toBe(true);
    expect(is503Error(new Error("status: 503"))).toBe(true);
    expect(is503Error(new Error("port 5001 already in use"))).toBe(false);
    expect(is503Error(new Error("error code 50042"))).toBe(false);
  });
});

describe("isModelFallbackError", () => {
  it("engages on 404 — the retired-model incident the old chain missed", () => {
    expect(isModelFallbackError(new Error("404 No endpoints found for google/gemini-2.5-flash:free"))).toBe(true);
  });

  it("engages on everything retriable, refuses auth failures", () => {
    expect(isModelFallbackError(sdkError(503, "boom"))).toBe(true);
    expect(isModelFallbackError(sdkError(401, "bad key"))).toBe(false);
    expect(isModelFallbackError(new Error("403 Host not in allowlist"))).toBe(false);
  });
});
