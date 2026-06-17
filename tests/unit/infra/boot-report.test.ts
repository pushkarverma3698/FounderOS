import { describe, it, expect } from "vitest";
import { buildBootReport } from "../../../src/infra/boot-report.js";

const find = (report: ReturnType<typeof buildBootReport>, name: string) => {
  const c = report.find((x) => x.name === name);
  if (!c) throw new Error(`capability not found: ${name}`);
  return c;
};

describe("buildBootReport", () => {
  it("reports LLM as MISSING when the selected provider key is absent", () => {
    const report = buildBootReport({});
    expect(find(report, "LLM (selected provider)").live).toBe(false);
  });

  it("reports LLM as LIVE when the selected provider key is present", () => {
    const report = buildBootReport({ OPENROUTER_API_KEY: "sk-or-v1-x" });
    expect(find(report, "LLM (selected provider)").live).toBe(true);
  });

  it("supports Gemini when AGENT_MODEL selects google-genai", () => {
    const report = buildBootReport({
      AGENT_MODEL: "google-genai:gemini-2.5-flash",
      GOOGLE_GENERATIVE_AI_API_KEY: "AIza-x",
    });
    expect(find(report, "LLM (selected provider)").live).toBe(true);
  });

  it("treats whitespace-only keys as MISSING", () => {
    const report = buildBootReport({ COMPOSIO_API_KEY: "   " });
    expect(find(report, "Composio (email/linkedin/calendar)").live).toBe(false);
  });

  it("marks the Claude executor LIVE even with no key (OAuth is the default)", () => {
    const report = buildBootReport({});
    const exec = find(report, "Claude executor");
    expect(exec.live).toBe(true);
    expect(exec.detail).toContain("OAuth");
  });

  it("notes API-key auth when CLAUDE_EXECUTOR_API_KEY is set", () => {
    const report = buildBootReport({ CLAUDE_EXECUTOR_API_KEY: "sk-ant-x" });
    expect(find(report, "Claude executor").detail).toContain("API-key");
  });

  it("loudly warns when model fallback is unarmed (G1: total-outage risk)", () => {
    const missing = find(buildBootReport({}), "LLM fallbacks");
    expect(missing.live).toBe(false);
    expect(missing.detail).toContain("NO model fallback configured");
    expect(missing.detail).toContain("AGENT_FALLBACK_MODELS");
  });

  it("reports model fallback armed when fallback models are configured", () => {
    const armed = find(
      buildBootReport({ AGENT_FALLBACK_MODELS: "anthropic:claude-haiku-4-5" }),
      "LLM fallbacks",
    );
    expect(armed.live).toBe(true);
    expect(armed.detail).toContain("modelFallbackMiddleware armed");
  });

  it("only reports LangSmith LIVE when both key AND tracing flag are set", () => {
    expect(find(buildBootReport({ LANGCHAIN_API_KEY: "ls-x" }), "Observability (LangSmith)").live).toBe(false);
    expect(
      find(
        buildBootReport({ LANGCHAIN_API_KEY: "ls-x", LANGCHAIN_TRACING_V2: "true" }),
        "Observability (LangSmith)",
      ).live,
    ).toBe(true);
  });

  it("covers every documented integration (stable surface)", () => {
    const names = buildBootReport({}).map((c) => c.name);
    expect(names).toEqual([
      "LLM (selected provider)",
      "LLM fallbacks",
      "Composio (email/linkedin/calendar)",
      "Gmail read backend",
      "GitHub tools",
      "Web search (Firecrawl)",
      "Claude executor",
      "Observability (LangSmith)",
      "RAG embeddings (Ollama)",
    ]);
  });
});

describe("config fail-fast (production)", () => {
  it("rejects production env without an LLM key", async () => {
    const { envSchema } = await import("../../../src/core/config.js");
    const result = envSchema.safeParse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHAT_ID: "1",
      NODE_ENV: "production",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("AGENT_MODEL"))).toBe(true);
    }
  });

  it("accepts production env when the LLM key is present", async () => {
    const { envSchema } = await import("../../../src/core/config.js");
    const result = envSchema.safeParse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHAT_ID: "1",
      NODE_ENV: "production",
      OPENROUTER_API_KEY: "sk-or-v1-x",
    });
    expect(result.success).toBe(true);
  });

  it("does not require an LLM key in development", async () => {
    const { envSchema } = await import("../../../src/core/config.js");
    const result = envSchema.safeParse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHAT_ID: "1",
    });
    expect(result.success).toBe(true);
  });
});
