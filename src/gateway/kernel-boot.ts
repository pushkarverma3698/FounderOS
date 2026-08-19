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
  type KernelChatModel,
  type KernelTool,
  type WorkerSpec,
  WORKERS,
} from "../kernel/index.js";
import { costAttributionMetadata, type CostAttribution, type CostStage } from "../infra/budget.js";
import type { RunnableConfig } from "@langchain/core/runnables";
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
import {
  getFailureLesson,
  upsertFailureLesson,
  recordFailureOccurrence,
  bumpFailureLessonApplied,
} from "../db/queries.js";
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

/**
 * Which worker a given tool ARRAY belongs to. The kernel's agent node calls
 * `model.bindTools(spec.tools)` with the very array built below, so a lookup
 * keyed on that array names the spender exactly — no string matching, no
 * guessing from prompt text. WeakMap so a rebuilt spec set is collectable.
 *
 * Registered in buildWorkerSpecs(), read in withCostIdentity(); both live in
 * this file so the two ends cannot drift apart unseen.
 */
const WORKER_BY_TOOLSET = new WeakMap<object, string>();

/**
 * A model whose invoke accepts a run config — i.e. a real LangChain Runnable.
 * withCostIdentity must sit INNERMOST, directly around such a model, because
 * the retry/fallback/cache wrappers take messages only and cannot forward a
 * config down to the provider call.
 */
interface ConfigurableModel extends KernelBindableModel {
  invoke(messages: Parameters<KernelChatModel["invoke"]>[0], config?: RunnableConfig): ReturnType<KernelChatModel["invoke"]>;
}

/**
 * Wrap a kernel model so every LLM call it makes carries `attribution` as run
 * METADATA (see src/infra/budget.ts for why metadata and not an async-local
 * scope). Identity is known HERE, at construction: the kernel is handed a
 * distinct model per stage, and bindTools() reveals which worker is about to run.
 *
 * Only `metadata` is set, so ensureConfig's key-by-key overlay leaves the
 * ambient callbacks — including the BudgetGuardCallback itself — untouched.
 *
 * A worker turn with no tools bound (tool budget spent — the finalize turn)
 * keeps the stage-level actor "worker": under-precise, never wrong.
 */
export function withCostIdentity(
  model: KernelBindableModel,
  attribution: CostAttribution,
): KernelBindableModel {
  const metadata = costAttributionMetadata(attribution);
  const configurable = model as ConfigurableModel;
  return {
    invoke: (messages) => configurable.invoke(messages, { metadata }),
    bindTools(tools: KernelTool[]): KernelChatModel {
      const worker = WORKER_BY_TOOLSET.get(tools);
      const bound = model.bindTools ? model.bindTools(tools) : model;
      return withCostIdentity(bound as KernelBindableModel, worker ? { ...attribution, agent: worker } : attribution);
    },
  };
}

export function buildWorkerSpecs(): WorkerSpec[] {
  return WORKERS.map((id) => {
    const prompt = PROMPTS[id];
    const tools = (DEPARTMENT_TOOLS[id] ?? []).filter(
      (t) => !isUnconfiguredTool((t as { name?: string }).name ?? ""),
    );
    WORKER_BY_TOOLSET.set(tools, id);
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
          times_resolved: row.times_resolved,
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
    async recordOccurrence(occurrence): Promise<void> {
      try {
        await recordFailureOccurrence({ tenant_id: TENANT, ...occurrence });
      } catch (err) {
        log.warn(
          { err: String(err), worker: occurrence.worker },
          "Failure-occurrence record failed — non-fatal", // allow-failopen: lessons are an accelerant, never a dependency
        );
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
  // Cost attribution sits INNERMOST, directly around each real provider model:
  // it attaches run metadata to the invoke config, and the retry/fallback/cache
  // wrappers take messages only, so a config attached further out would never
  // reach the provider call. The fallback models are wrapped with the SAME
  // identity — a fallback's spend belongs to the stage that asked for it, and
  // the `model` column already records which model actually answered.
  const identify = (stage: CostStage, agent: string) =>
    (m: KernelBindableModel): KernelBindableModel => withCostIdentity(m, { agent, stage });
  const asPlanner = identify("planner", "planner");
  const asWorker = identify("worker", "worker");
  const asSynthesizer = identify("synthesizer", "synthesizer");
  return buildKernel({
    plannerModel: cachePlanner(
      withModelFallbacks(
        withModelRetry(asPlanner(getModel() as unknown as KernelBindableModel), { label: "planner" }),
        fallbacks.map((m) => asPlanner(m)),
        "planner",
      ),
    ),
    workerModel: withModelFallbacks(
      withModelRetry(asWorker(getWorkerModel() as unknown as KernelBindableModel), { label: "worker" }),
      fallbacks.map((m) => asWorker(m)),
      "worker",
    ),
    synthesizerModel: cacheSynth(
      withModelFallbacks(
        withModelRetry(asSynthesizer(getWorkerModel() as unknown as KernelBindableModel), {
          label: "synthesizer",
        }),
        fallbacks.map((m) => asSynthesizer(m)),
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
