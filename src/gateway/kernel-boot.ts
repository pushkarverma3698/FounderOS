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
import {
  buildFallbackModels,
  getModel,
  getWorkerModel,
  getConfiguredModelId,
  getWorkerModelId,
  resolveTemperature,
} from "../agents/model.js";
import { withModelFallbacks } from "./model-fallback.js";
import { withModelRetry } from "./model-retry.js";
import { withLlmCache } from "./model-cache.js";
import { env } from "../core/config.js";
import { DEPARTMENT_TOOLS, applyMcpBridge } from "../agents/capabilities.js";
import { applySkillSynthesisLoader } from "../agents/skill-loader.js";
import { resolveVpsRunConfig } from "../tools/vps-run.js";
import { getCheckpointer } from "../infra/checkpointer.js";
import { getFailureLesson, upsertFailureLesson, bumpFailureLessonApplied } from "../db/queries.js";
import { TENANT } from "../core/config.js";
import type { FailureLesson, LessonStore } from "../kernel/index.js";
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

/**
 * Tools that are only useful when their backing infrastructure is configured.
 * Offering an unconfigured tool to the planner/worker is worse than not having
 * it: the LLM picks it, the founder burns HITL approvals, and it fails on
 * execute with a `not configured` error. Gate them out of the offered set so the
 * agent routes to a tool that can actually succeed. (2026-07-18: prod had
 * VPS_RUN_HOST unset, so every vps_run attempt cost two HITL approvals then died
 * with `vps-config: vps_run is not configured`.)
 */
function isUnconfiguredTool(toolName: string): boolean {
  if (toolName === "vps_run") return resolveVpsRunConfig() === null;
  // synthesize_skill writes + compiles TypeScript into the running app's source
  // tree. Withheld unless explicitly enabled (2026-08-08 audit, F-07) — the same
  // "don't offer what can't safely run" reasoning as vps_run above.
  // Read from process.env at CALL time, not from the frozen `env` object: the
  // flag has to be flippable inside a test, and a security gate nobody can test
  // both ways is a gate nobody can prove is closed.
  if (toolName === "synthesize_skill") return process.env["SKILL_SYNTHESIS_ENABLED"] !== "true";
  return false;
}

export function buildWorkerSpecs(): WorkerSpec[] {
  return WORKERS.map((id) => {
    const prompt = PROMPTS[id];
    const tools = (DEPARTMENT_TOOLS[id] ?? []).filter(
      (t) => !isUnconfiguredTool((t as { name?: string }).name ?? ""),
    );
    return {
      id,
      description: DESCRIPTIONS[id],
      prompt: typeof prompt === "function" ? prompt() : prompt,
      tools: tools as unknown as KernelTool[],
    };
  });
}

/**
 * Postgres-backed LessonStore (the Hermes learning seam). Failure-tolerant on
 * every edge: lessons are an accelerant — a DB blip must degrade to "no
 * lesson", never to a broken retry.
 */
export function buildLessonStore(): LessonStore {
  return {
    async lookup(worker: string, signature: string): Promise<FailureLesson | null> {
      try {
        const row = await getFailureLesson(TENANT, worker, signature);
        if (!row) return null;
        void bumpFailureLessonApplied(row.id).catch(() => undefined); // allow-failopen: applied-count is telemetry; the lookup result matters, the counter does not
        return {
          worker: row.worker,
          signature: row.signature,
          component: row.component,
          objective: row.objective,
          resolved_with_tools: row.resolved_with_tools ?? [],
          times_seen: row.times_seen,
          last_resolved_at: (row.last_resolved_at ?? new Date()).toISOString(),
        };
      } catch (err) {
        log.warn({ err: String(err), worker }, "Failure-lesson lookup failed — retry proceeds without it"); // allow-failopen: lessons are an accelerant, never a dependency
        return null;
      }
    },
    async record(lesson): Promise<void> {
      try {
        await upsertFailureLesson({ tenant_id: TENANT, ...lesson });
        log.info({ worker: lesson.worker, signature: lesson.signature.slice(0, 80) }, "Failure lesson recorded");
      } catch (err) {
        log.warn({ err: String(err), worker: lesson.worker }, "Failure-lesson record failed — non-fatal"); // allow-failopen: lessons are an accelerant, never a dependency
      }
    },
  };
}

/** Build a kernel against an injected checkpointer (tests: MemorySaver). */
export function buildProductionKernel(checkpointer: BaseCheckpointSaver): CompiledKernel {
  // 2026-07-11: wrap every kernel model with the AGENT_FALLBACK_MODELS chain.
  // Without this the configured free OpenRouter fallbacks never engaged — a
  // Gemini quota/retirement error surfaced raw at the founder on every turn.
  const fallbacks = buildFallbackModels() as unknown as KernelBindableModel[];
  // LLM response cache (opt-in, off by default). Only the side-effect-free
  // planner + synthesizer calls are cached; worker tool-calling is excluded by
  // construction (withLlmCache.bindTools bypasses the cache). Layered OUTSIDE
  // the fallback chain so a hit skips it entirely.
  const cacheEnabled = env.LLM_CACHE_ENABLED === "true";
  const temperature = resolveTemperature();
  const cachePlanner = (m: KernelBindableModel): KernelBindableModel =>
    withLlmCache(m, {
      enabled: cacheEnabled,
      tenantId: TENANT,
      modelId: getConfiguredModelId(),
      temperature,
      ttlSeconds: env.LLM_CACHE_TTL_SECONDS,
    });
  const cacheSynth = (m: KernelBindableModel): KernelBindableModel =>
    withLlmCache(m, {
      enabled: cacheEnabled,
      tenantId: TENANT,
      modelId: getWorkerModelId(),
      temperature,
      ttlSeconds: env.LLM_CACHE_TTL_SECONDS,
    });
  // Retry-with-jitter sits INSIDE the fallback chain: a transient 429/529 on
  // the primary is absorbed with backoff before a fallback (different model,
  // different answers) has to take over. Auth/404 pass straight through.
  return buildKernel({
    plannerModel: cachePlanner(
      withModelFallbacks(
        withModelRetry(getModel() as unknown as KernelBindableModel, { label: "planner" }),
        fallbacks,
        "planner",
      ),
    ),
    workerModel: withModelFallbacks(
      withModelRetry(getWorkerModel() as unknown as KernelBindableModel, { label: "worker" }),
      fallbacks,
      "worker",
    ),
    synthesizerModel: cacheSynth(
      withModelFallbacks(
        withModelRetry(getWorkerModel() as unknown as KernelBindableModel, { label: "synthesizer" }),
        fallbacks,
        "synthesizer",
      ),
    ),
    workers: buildWorkerSpecs(),
    checkpointer,
    lessons: buildLessonStore(),
  });
}

let _kernel: CompiledKernel | undefined;

/** Compile once with the Postgres checkpointer; reuse forever (rule #2). */
export async function getKernel(): Promise<CompiledKernel> {
  if (_kernel) return _kernel;
  await applyMcpBridge(); // merge external MCP tools before specs read DEPARTMENT_TOOLS
  // Same phase, same ordering constraint, right after applyMcpBridge so the
  // synthesized-tool collision check also sees any already-bridged MCP names.
  // No-op (not even a readdir) unless SKILL_SYNTHESIS_ENABLED — see
  // src/agents/skill-loader.ts for the full untrusted-input discipline.
  await applySkillSynthesisLoader();
  const checkpointer = await getCheckpointer();
  _kernel = buildProductionKernel(checkpointer as unknown as BaseCheckpointSaver);
  log.info(`Kernel compiled: planner + pure supervisor + ${WORKERS.length} workers + synthesizer`);
  return _kernel;
}

/**
 * Drop the compiled-kernel singleton so the NEXT getKernel() rebuilds — used by
 * `/connect` after adding an MCP server so its tools become live without a
 * process restart. Safe because an in-flight turn already holds its own kernel
 * reference; only the next turn recompiles (and applyMcpBridge is idempotent).
 */
export function resetKernelCache(): void {
  _kernel = undefined;
}
