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

  it("reports LinkedIn direct as MISSING without token + URN", () => {
    const report = buildBootReport({});
    expect(find(report, "LinkedIn (direct API)").live).toBe(false);
  });

  it("reports LinkedIn direct as LIVE with token + URN", () => {
    const report = buildBootReport({
      LINKEDIN_ACCESS_TOKEN: "token",
      LINKEDIN_AUTHOR_URN: "urn:li:person:x",
    });
    expect(find(report, "LinkedIn (direct API)").live).toBe(true);
  });

  it("marks the Claude executor LIVE even with no key (OAuth is the default)", () => {
    const report = buildBootReport({});
    const exec = find(report, "Claude executor");
    expect(exec.live).toBe(true);
    expect(exec.detail).toContain("OAuth");
  });

  it("loudly warns when model fallback is unarmed (G1: total-outage risk)", () => {
    const missing = find(buildBootReport({}), "LLM fallbacks");
    expect(missing.live).toBe(false);
    expect(missing.detail).toContain("NO model fallback configured");
  });

  it("covers every documented integration (stable surface)", () => {
    const names = buildBootReport({}).map((c) => c.name);
    expect(names).toEqual([
      "LLM (selected provider)",
      "LLM fallbacks",
      "Google Workspace (gws)",
      "LinkedIn (direct API)",
      "Composio (legacy fallback)",
      "GitHub tools",
      "Web search (Firecrawl)",
      "Claude executor",
      "Observability (LangSmith)",
      "RAG embeddings (Ollama)",
      "Image delivery storage (S3)",
    ]);
  });

  it("warns when Gemini key is set but S3 storage is missing", () => {
    const row = find(buildBootReport({
      GOOGLE_GENERATIVE_AI_API_KEY: "AIza-x",
    }), "Image delivery storage (S3)");
    expect(row.live).toBe(false);
    expect(row.detail).toContain("STORAGE_BUCKET");
  });

  it("reports S3 LIVE when Gemini + storage credentials are present", () => {
    const row = find(buildBootReport({
      GOOGLE_GENERATIVE_AI_API_KEY: "AIza-x",
      STORAGE_BUCKET: "founderos-assets",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
    }), "Image delivery storage (S3)");
    expect(row.live).toBe(true);
    expect(row.detail).toContain("founderos-assets");
  });
});
