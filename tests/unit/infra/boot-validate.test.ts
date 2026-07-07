/**
 * Strict boot-validation tests.
 *
 * These prove that a fatal misconfig (dead LLM provider, missing DB, missing
 * Telegram transport) produces a LOUD boot error — not a silently half-dead bot
 * that fails in production. Pure function, fully offline.
 */

import { describe, it, expect } from "vitest";
import { validateBootConfig, assertBootConfigOrThrow } from "../../../src/infra/boot-validate.js";

/** A fully-valid baseline config; individual tests break one field at a time. */
const VALID = {
  AGENT_MODEL: "google-genai:gemini-2.5-flash",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-key",
  AGENT_FALLBACK_MODELS: "openrouter:openai/gpt-4o-mini",
  LINKEDIN_ACCESS_TOKEN: "li_token",
  LINKEDIN_AUTHOR_URN: "urn:li:person:test",
  GITHUB_TOKEN: "ghp_test",
  DATABASE_URL: "postgresql://founderos:founderos@localhost:5432/founderos",
  TELEGRAM_BOT_TOKEN: "1234567890:AAExampleBotFatherToken_abc",
  TELEGRAM_CHAT_ID: "-1001234567890",
};

describe("validateBootConfig — passing config", () => {
  it("a fully-valid config has zero errors and zero warnings", () => {
    const { errors, warnings } = validateBootConfig(VALID);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("assertBootConfigOrThrow does not throw on a valid config", () => {
    expect(() => assertBootConfigOrThrow(VALID)).not.toThrow();
  });
});

describe("validateBootConfig — fatal errors", () => {
  it("errors when the selected LLM provider has no matching key", () => {
    const { errors } = validateBootConfig({ ...VALID, GOOGLE_GENERATIVE_AI_API_KEY: undefined });
    expect(errors.some((e) => e.includes("LLM provider not configured"))).toBe(true);
  });

  it("errors when DATABASE_URL is missing", () => {
    const { errors } = validateBootConfig({ ...VALID, DATABASE_URL: undefined });
    expect(errors.some((e) => e.includes("DATABASE_URL is not set"))).toBe(true);
  });

  it("errors when DATABASE_URL uses the postgres superuser", () => {
    const { errors } = validateBootConfig({
      ...VALID,
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/founderos",
    });
    expect(errors.some((e) => e.includes("'postgres' superuser"))).toBe(true);
  });

  it("errors when TELEGRAM_BOT_TOKEN is missing", () => {
    const { errors } = validateBootConfig({ ...VALID, TELEGRAM_BOT_TOKEN: undefined });
    expect(errors.some((e) => e.includes("TELEGRAM_BOT_TOKEN is not set"))).toBe(true);
  });

  it("errors when TELEGRAM_CHAT_ID is missing", () => {
    const { errors } = validateBootConfig({ ...VALID, TELEGRAM_CHAT_ID: undefined });
    expect(errors.some((e) => e.includes("TELEGRAM_CHAT_ID is not set"))).toBe(true);
  });

  it("assertBootConfigOrThrow throws and lists every fatal error", () => {
    expect(() =>
      assertBootConfigOrThrow({ ...VALID, GOOGLE_GENERATIVE_AI_API_KEY: undefined, DATABASE_URL: undefined }),
    ).toThrow(/Boot validation failed \(2 fatal/);
  });
});

describe("validateBootConfig — non-fatal warnings", () => {
  it("warns (not errors) when no LLM fallback is configured", () => {
    const { errors, warnings } = validateBootConfig({ ...VALID, AGENT_FALLBACK_MODELS: undefined });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("No LLM fallback"))).toBe(true);
  });

  it("warns when the Telegram token is malformed (would 401 at polling)", () => {
    const { errors, warnings } = validateBootConfig({ ...VALID, TELEGRAM_BOT_TOKEN: "not-a-valid-token" });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("not in '<digits>:<token>' shape"))).toBe(true);
  });

  it("warns when optional integrations are missing", () => {
    const { errors, warnings } = validateBootConfig({
      ...VALID,
      LINKEDIN_ACCESS_TOKEN: undefined,
      LINKEDIN_AUTHOR_URN: undefined,
      GITHUB_TOKEN: undefined,
    });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("LinkedIn"))).toBe(true);
    expect(warnings.some((w) => w.includes("GitHub"))).toBe(true);
  });
});
