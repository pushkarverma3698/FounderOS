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
});
