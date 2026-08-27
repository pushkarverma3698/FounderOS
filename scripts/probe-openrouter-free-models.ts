/**
 * FounderOS — OpenRouter free-model liveness probe
 * =================================================
 * OpenRouter retires free-tier model slugs without notice (a paid version
 * keeps the id; the free one 404s with "use this slug instead"). That silently
 * killed the last two entries of AGENT_FALLBACK_MODELS and the JUDGE_MODEL
 * default (2026-08-27) — nothing alerted, prod just quietly had no working
 * OpenRouter fallback and content-judge degraded to "skipped" every call.
 *
 * Run against whatever is actually configured (AGENT_FALLBACK_MODELS,
 * JUDGE_MODEL) so a stale slug is caught before it's needed for real:
 *
 *   node --env-file=.env --import tsx/esm scripts/probe-openrouter-free-models.ts
 *
 * Exit 0 = every configured openrouter: slug responded. Exit 1 = at least one
 * is DEAD (404/paid-only) or unreachable — loud, not a quiet log line.
 * RATE_LIMITED (429, shared free pool) is reported but does not fail the
 * probe — the model isn't gone, it's just busy right now.
 */

import { getFallbackModelIds } from "../src/agents/model.js";
import { JUDGE_MODEL } from "./lib/content-judge.js";

interface ProbeResult {
  id: string;
  status: "ALIVE" | "DEAD" | "RATE_LIMITED" | "NO_CREDITS" | "ERROR";
  detail: string;
}

function openrouterModelsFrom(ids: string[]): string[] {
  return ids
    .filter((id) => id.startsWith("openrouter:"))
    .map((id) => id.slice("openrouter:".length));
}

async function probeModel(model: string, apiKey: string): Promise<ProbeResult> {
  const id = `openrouter:${model}`;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
    });
    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    if (!body.error) return { id, status: "ALIVE", detail: `HTTP ${res.status}` };
    const code = body.error.code;
    if (code === 404) return { id, status: "DEAD", detail: body.error.message ?? "404" };
    if (code === 402) return { id, status: "NO_CREDITS", detail: body.error.message ?? "402" };
    if (code === 429) return { id, status: "RATE_LIMITED", detail: body.error.message ?? "429" };
    return { id, status: "ERROR", detail: `${code}: ${body.error.message ?? "unknown"}` };
  } catch (err) {
    return { id, status: "ERROR", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("[probe] OPENROUTER_API_KEY not set — nothing to probe.");
    process.exit(1);
  }

  const judgeModel = JUDGE_MODEL.startsWith("openrouter:") ? [JUDGE_MODEL.slice("openrouter:".length)] : [];
  const fallbackModels = openrouterModelsFrom(getFallbackModelIds());
  const models = [...new Set([...fallbackModels, ...judgeModel])];

  if (models.length === 0) {
    console.log("[probe] No openrouter: model ids configured in AGENT_FALLBACK_MODELS/JUDGE_MODEL — nothing to probe.");
    process.exit(0);
  }

  const tag: Record<ProbeResult["status"], string> = {
    ALIVE: "✅",
    DEAD: "❌",
    RATE_LIMITED: "⚠️ ",
    NO_CREDITS: "⚠️ ",
    ERROR: "❌",
  };

  let hasDead = false;
  for (const model of models) {
    const result = await probeModel(model, apiKey);
    if (result.status === "DEAD" || result.status === "ERROR") hasDead = true;
    console.log(`${tag[result.status]} ${result.status.padEnd(13)} ${result.id} — ${result.detail}`);
  }

  process.exit(hasDead ? 1 : 0);
}

main().catch((err) => {
  console.error("[probe] crashed:", err);
  process.exit(1);
});
