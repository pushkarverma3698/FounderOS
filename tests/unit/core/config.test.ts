import { describe, it, expect } from "vitest";
import { envSchema } from "../../../src/core/config.js";

describe("env config — embedding + executor vars", () => {
  it("defaults OLLAMA_URL, EMBED_MODEL, EMBED_DIM and accepts optional executor key", () => {
    const parsed = envSchema.parse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHAT_ID: "1",
    });
    expect(parsed.OLLAMA_URL).toBe("http://localhost:11434");
    expect(parsed.EMBED_MODEL).toBe("nomic-embed-text");
    expect(parsed.EMBED_DIM).toBe(768);
    expect(parsed.CLAUDE_EXECUTOR_API_KEY).toBeUndefined();
  });

  it("defaults integration backends to direct APIs (ADR-029)", () => {
    const parsed = envSchema.parse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHAT_ID: "1",
    });
    expect(parsed.GMAIL_BACKEND).toBe("gws");
    expect(parsed.LINKEDIN_BACKEND).toBe("direct");
  });

  it("keeps FIRECRAWL_API_KEY through parsing (boot report read it as always-missing, 2026-07-12)", () => {
    // Zod strips unknown keys: FIRECRAWL_API_KEY was absent from envSchema, so
    // logBootReport(env) reported Firecrawl MISSING on prod even with the key
    // set in .env. Every key BootCapabilityInput inspects must survive parseEnv.
    const parsed = envSchema.parse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHAT_ID: "1",
      FIRECRAWL_API_KEY: "fc-test-key",
    });
    expect(parsed.FIRECRAWL_API_KEY).toBe("fc-test-key");
  });
});
