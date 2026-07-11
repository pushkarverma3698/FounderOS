/**
 * FounderOS v3 — kernel composition root.
 * ========================================
 * The ONE place real models, real tools, and the Postgres checkpointer meet
 * the kernel. The kernel itself is a pure library (src/kernel/); everything
 * provider-shaped is injected here so tests inject fakes at the same seam.
 *
 * Tools are the existing LangChain agent-tools (HITL gates already inside via
 * infra/hitl.hitlGate) — they satisfy KernelTool structurally: name +
 * invoke(args, config).
 */

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import {
  buildKernel,
  type CompiledKernel,
  type KernelBindableModel,
  type KernelTool,
  type WorkerSpec,
  WORKERS,
} from "../kernel/index.js";
import { buildFallbackModels, getModel, getWorkerModel } from "../agents/model.js";
import { withModelFallbacks } from "./model-fallback.js";
import { DEPARTMENT_TOOLS, applyMcpBridge } from "../agents/capabilities.js";
import { getCheckpointer } from "../infra/checkpointer.js";
import {
  ADMIN_PROMPT,
  RESEARCH_PROMPT,
  buildCommsPrompt,
  ENGINEERING_PROMPT,
  MARKETING_PROMPT,
  SALES_PROMPT,
  PERSONAL_PROMPT,
  JOBHUNT_PROMPT,
} from "../agents/system-prompts.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "kernel-boot" });

/** Worker routing descriptions for the planner catalog (formerly office.ts). */
const DESCRIPTIONS: Record<(typeof WORKERS)[number], string> = {
  admin: "Business context, episodic memory, recording decisions, pending cross-department signals.",
  research: "Web facts, news, company/market research, ICP scoring, internal Turicks knowledge lookups.",
  comms: "Reading inbox, known-contact email, Google Calendar work.",
  engineering: "GitHub repos, issues, PRs, code, tests, deployments, FounderOS engineering work.",
  marketing: "LinkedIn posts, content strategy, comment replies, Turicks brand copy, image generation (draft + final), brand asset library.",
  sales: "Prospect research tied to cold outreach, unknown-company outreach, sales emails.",
  personal: "Files, directories, shell, browser, and laptop operations on the founder's machine.",
  jobhunt: "Job searches, CV/resume work, applications, hiring-manager outreach.",
};

const PROMPTS: Record<(typeof WORKERS)[number], string | (() => string)> = {
  admin: ADMIN_PROMPT,
  research: RESEARCH_PROMPT,
  comms: buildCommsPrompt,
  engineering: ENGINEERING_PROMPT,
  marketing: MARKETING_PROMPT,
  sales: SALES_PROMPT,
  personal: PERSONAL_PROMPT,
  jobhunt: JOBHUNT_PROMPT,
};

export function buildWorkerSpecs(): WorkerSpec[] {
  return WORKERS.map((id) => {
    const prompt = PROMPTS[id];
    return {
      id,
      description: DESCRIPTIONS[id],
      prompt: typeof prompt === "function" ? prompt() : prompt,
      tools: (DEPARTMENT_TOOLS[id] ?? []) as unknown as KernelTool[],
    };
  });
}

/** Build a kernel against an injected checkpointer (tests: MemorySaver). */
export function buildProductionKernel(checkpointer: BaseCheckpointSaver): CompiledKernel {
  // 2026-07-11: wrap every kernel model with the AGENT_FALLBACK_MODELS chain.
  // Without this the configured free OpenRouter fallbacks never engaged — a
  // Gemini quota/retirement error surfaced raw at the founder on every turn.
  const fallbacks = buildFallbackModels() as unknown as KernelBindableModel[];
  return buildKernel({
    plannerModel: withModelFallbacks(
      getModel() as unknown as KernelBindableModel,
      fallbacks,
      "planner",
    ),
    workerModel: withModelFallbacks(
      getWorkerModel() as unknown as KernelBindableModel,
      fallbacks,
      "worker",
    ),
    synthesizerModel: withModelFallbacks(
      getWorkerModel() as unknown as KernelBindableModel,
      fallbacks,
      "synthesizer",
    ),
    workers: buildWorkerSpecs(),
    checkpointer,
  });
}

let _kernel: CompiledKernel | undefined;

/** Compile once with the Postgres checkpointer; reuse forever (rule #2). */
export async function getKernel(): Promise<CompiledKernel> {
  if (_kernel) return _kernel;
  await applyMcpBridge(); // merge external MCP tools before specs read DEPARTMENT_TOOLS
  const checkpointer = await getCheckpointer();
  _kernel = buildProductionKernel(checkpointer as unknown as BaseCheckpointSaver);
  log.info(`Kernel compiled: planner + pure supervisor + ${WORKERS.length} workers + synthesizer`);
  return _kernel;
}
