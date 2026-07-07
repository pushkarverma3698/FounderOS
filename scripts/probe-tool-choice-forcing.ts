/**
 * Gate 1 — proves whether OpenRouter actually honours native `tool_choice`
 * forcing for Gemini-2.5-Pro. This is the single hard blocker for the
 * FORCE_TOOL_CHOICE rollout: if the provider silently ignores tool_choice,
 * turning the flag on would disable 5 execution-guard detectors while adding
 * ZERO real protection (see docs/decisions plan "fix/guard-scar-tissue-forcing").
 *
 * Real path: constructs the model the same way src/agents/model.ts does for
 * the `openrouter:` branch, binds a single dummy tool, and issues a request
 * with `tool_choice: {type:"function", function:{name: <tool>}}` — the exact
 * shape forceToolChoiceMiddleware() sets (src/infra/context-manager.ts:319) —
 * on an input that would NOT naturally trigger that tool. If forcing works,
 * the model MUST call the tool anyway.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/probe-tool-choice-forcing.ts
 */
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const MODEL_ID = process.env["PROBE_MODEL"] ?? "google/gemini-2.5-pro";

async function main() {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing — cannot run a live probe.");
    process.exit(1);
  }

  const model = new ChatOpenAI({
    model: MODEL_ID,
    apiKey,
    temperature: 0,
    configuration: { baseURL: "https://openrouter.ai/api/v1" },
  });

  const dummyTool = tool(async ({ query }: { query: string }) => `no results for ${query}`, {
    name: "run_shell",
    description: "Runs a shell command and returns stdout.",
    schema: z.object({ query: z.string().describe("the shell command to run") }),
  });

  const decoyTool = tool(async ({ topic }: { topic: string }) => `no results for ${topic}`, {
    name: "search_web",
    description: "Searches the web for a topic.",
    schema: z.object({ topic: z.string() }),
  });

  const bound = model.bindTools([dummyTool, decoyTool], {
    tool_choice: { type: "function", function: { name: "run_shell" } },
  });

  // Deliberately unrelated input — a model NOT being forced would just answer in prose.
  const input = "Hi there, how are you today?";
  console.log(`Model: ${MODEL_ID} (via OpenRouter)`);
  console.log(`Forced tool: run_shell | Input: "${input}"\n`);

  const res = await bound.invoke(input);
  const toolCalls = (res.tool_calls ?? []).map((tc) => tc.name);

  console.log("Tool calls in response:", toolCalls.length ? toolCalls : "(none — prose only)");
  console.log("Response content preview:", String(res.content).slice(0, 200));

  const forced = toolCalls.includes("run_shell");
  console.log(`\nGATE 1 RESULT: ${forced ? "PASS — tool_choice forcing IS honoured" : "FAIL — forcing did NOT trigger the tool"}`);
  process.exit(forced ? 0 : 1);
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
