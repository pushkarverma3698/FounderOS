/**
 * FounderOS v3 kernel — the inter-agent contracts.
 * =================================================
 * EVERY boundary in the orchestration kernel is one of these Zod schemas.
 * A payload that fails its schema is a terminal, reported failure — never a
 * retry-and-hope, never guessed data (approved plan: "fix the schema, not the
 * code"). All validators are pure and total: they never throw.
 *
 * Data flow (JARVIS-ARCHITECTURE.md):
 *   input → Plan (planner LLM, validated once)
 *         → TaskEnvelope per step (worker sees ONLY this)
 *         → StepResult (ok + ToolReceipts | failed + FailureReport)
 *         → synthesizer speaks only from validated results.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { SIGNAL_CONTRACTS } from "./signals.js";

export const KERNEL_SCHEMA_VERSION = 1 as const;

// ── Workers (closed set — the department taxonomy) ────────────────────────────

export const WORKERS = [
  "admin",
  "research",
  "comms",
  "engineering",
  "marketing",
  "sales",
  "personal",
  "jobhunt",
] as const;
export type WorkerId = (typeof WORKERS)[number];
export const WorkerIdSchema = z.enum(WORKERS);

// ── Failure report (rule #22 as a type: name the REAL failing component) ──────

export const FAILURE_STAGES = [
  "validation",
  "planning",
  "routing",
  "tool",
  "model",
  "budget",
  "timeout",
  "hitl_rejected",
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

export const FailureReportSchema = z.object({
  step_id: z.string().min(1),
  stage: z.enum(FAILURE_STAGES),
  /** The real failing component: "openrouter", "postgres/pgvector", "github_write"… */
  component: z.string().min(1),
  /** Human-readable; surfaced verbatim to the founder (fail loud). */
  message: z.string().min(1),
  /** Raw error snippet / HTTP status — the evidence, not a summary of it. */
  evidence: z.string().optional(),
  retryable: z.boolean(),
});
export type FailureReport = z.infer<typeof FailureReportSchema>;

// ── Tool receipts (ground truth for zero-hallucination) ───────────────────────

export const ToolReceiptSchema = z.object({
  tool: z.string().min(1),
  /** sha256 of canonical JSON args — lets audits match calls without storing PII. */
  args_hash: z.string().length(64),
  /** sha256 of the stringified result — proof of WHAT came back, compactly. */
  result_digest: z.string().length(64),
  ok: z.boolean(),
  at: z.string().datetime(),
  idempotency_key: z.string().optional(),
});
export type ToolReceipt = z.infer<typeof ToolReceiptSchema>;

/** Canonical hash helpers so receipts are reproducible across processes. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashToolArgs(args: unknown): string {
  return sha256Hex(stableStringify(args));
}

export function digestToolResult(result: unknown): string {
  return sha256Hex(typeof result === "string" ? result : stableStringify(result));
}

/** Deterministic JSON: sorted keys so the same args always hash the same. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

// ── Output contracts registry ─────────────────────────────────────────────────

/**
 * Every TaskEnvelope names the schema its output must satisfy via `schema_ref`.
 * The registry is the closed vocabulary; the parity test enforces that every
 * ref used anywhere resolves here. Signal payload schemas are included so a
 * step can produce a `dept_signals`-ready payload directly.
 */
/**
 * Live T01/T03 repair (kind-drift's sibling): models emit pure-text answers as
 * a bare string or {"summary": …} instead of {"text": …} — same honest
 * content, wrong wrapper. Repair the SHAPE in code; content is never altered.
 */
function coerceTextSummary(val: unknown): unknown {
  if (typeof val === "string") return { text: val };
  if (val && typeof val === "object" && !Array.isArray(val) && !("text" in val)) {
    const summary = (val as Record<string, unknown>)["summary"];
    if (typeof summary === "string") return { text: summary };
  }
  return val;
}

export const OUTPUT_CONTRACTS: Record<string, z.ZodTypeAny> = {
  /** Free-text answer/summary — the default for read/synthesis steps. */
  "text.summary": z.preprocess(coerceTextSummary, z.object({ text: z.string().min(1) })),
  /** Research findings with sources — grounded, not vibes. */
  "research.findings": z.object({
    summary: z.string().min(1),
    sources: z.array(z.object({ title: z.string().min(1), url: z.string().url().optional() })).default([]),
  }),
  /** Outbound email draft (send happens via HITL-gated tool, not via output). */
  "draft.email": z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  /** LinkedIn post draft. */
  "draft.linkedin_post": z.object({ body: z.string().min(1) }),
  /** Action step outcome — the receipts are the proof; the summary is for humans. */
  "action.summary": z.object({ summary: z.string().min(1) }),
  /** Escape hatch for structured data that has no dedicated contract yet. */
  "data.generic": z.record(z.unknown()),
  ...Object.fromEntries(Object.entries(SIGNAL_CONTRACTS).map(([k, v]) => [`signal.${k}`, v])),
};

export function isOutputSchemaRef(ref: string): boolean {
  return Object.prototype.hasOwnProperty.call(OUTPUT_CONTRACTS, ref);
}

/**
 * Live T01 repair: workers often finalize a pure-text step with the prose
 * answer itself (or jsonrepair mangles it into fragments) instead of
 * {"text": …}. For "text.summary" ONLY: keep the parsed value when the
 * contract already accepts it, else salvage the worker's raw final text.
 * Never invents content; validateStepResult (incl. the action-receipt gate)
 * still runs on the result. All other contracts are untouched.
 */
export function repairTextSummaryOutput(parsed: unknown, rawText: string): unknown {
  if (OUTPUT_CONTRACTS["text.summary"]!.safeParse(parsed).success) return parsed;
  return rawText.trim().length > 0 ? { text: rawText } : parsed;
}

// ── Task envelope (the ONLY thing a worker sees) ──────────────────────────────

export const MAX_TOOL_CALLS_PER_STEP = 6;
export const MAX_PLAN_STEPS = 8;

/**
 * Coarse output kinds. `kind` exists only to drive the action-receipt safety
 * check in validateStepResult (an "action_receipt" step must carry a real
 * successful receipt). It is otherwise fully derivable from schema_ref.
 */
export const EXPECTED_KINDS = ["data", "draft", "action_receipt"] as const;
export type ExpectedKind = (typeof EXPECTED_KINDS)[number];

/** Derive the coarse kind from a schema_ref prefix (deterministic, model-free). */
export function kindFromSchemaRef(schemaRef: unknown): ExpectedKind {
  const ref = typeof schemaRef === "string" ? schemaRef : "";
  if (ref.startsWith("draft.")) return "draft";
  if (ref === "action.summary") return "action_receipt";
  return "data";
}

/**
 * Repair planner drift (rule #16 — push correctness into code, not the prompt).
 * LLM planners frequently echo the schema_ref into `kind` (e.g.
 * kind:"research.findings" instead of "data"), which used to fail the ENTIRE
 * plan at the validation stage (live T02 outage, 2026-07-09). When `kind` is
 * not a valid coarse kind, derive it from schema_ref. A VALID model-emitted
 * kind — including "action_receipt" — is left untouched, so the receipt safety
 * check is never weakened.
 */
function normalizeExpectedKind(val: unknown): unknown {
  if (!val || typeof val !== "object") return val;
  const o = val as Record<string, unknown>;
  if ((EXPECTED_KINDS as readonly string[]).includes(o["kind"] as string)) return val;
  return { ...o, kind: kindFromSchemaRef(o["schema_ref"]) };
}

export const TaskEnvelopeSchema = z.object({
  step_id: z.string().min(1),
  worker: WorkerIdSchema,
  /** Explicit statement of the task — the planner may not delegate by vibes. */
  objective: z.string().min(8),
  /** Named inputs; values are prior step outputs referenced by the planner. */
  inputs: z.record(z.unknown()).default({}),
  expected: z.preprocess(
    normalizeExpectedKind,
    z.object({
      kind: z.enum(EXPECTED_KINDS),
      schema_ref: z.string().refine(isOutputSchemaRef, { message: "unknown output schema_ref" }),
    }),
  ),
  constraints: z.object({
    max_tool_calls: z.number().int().min(1).max(MAX_TOOL_CALLS_PER_STEP),
    hitl_required: z.boolean(),
  }),
});
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

// ── Plan ──────────────────────────────────────────────────────────────────────

export const PlanSchema = z.object({
  schema_version: z.literal(KERNEL_SCHEMA_VERSION),
  goal: z.string().min(1),
  steps: z
    .array(TaskEnvelopeSchema)
    .min(1)
    .max(MAX_PLAN_STEPS)
    .refine((steps) => new Set(steps.map((s) => s.step_id)).size === steps.length, {
      message: "step_id values must be unique",
    }),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Planner outcome: either a full plan, or a direct reply for inputs that need
 * no tools (greetings, clarifications, refusals). Direct replies make the
 * trivial path exactly ONE LLM call — the old system burned 4 on "hello".
 */
export const PlannerDecisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reply"), text: z.string().min(1) }),
  z.object({ type: z.literal("plan"), plan: PlanSchema }),
]);
export type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;

export function validatePlannerDecision(input: unknown): Validation<PlannerDecision> {
  const res = PlannerDecisionSchema.safeParse(input);
  return res.success
    ? { ok: true, value: res.data }
    : { ok: false, error: `Invalid planner decision — ${zodIssues(res.error)}` };
}

// ── Step result (discriminated — the supervisor branches on status, not prose) ─

export const StepResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    step_id: z.string().min(1),
    /** MUST validate against the envelope's expected.schema_ref (validateStepResult). */
    output: z.unknown(),
    tool_receipts: z.array(ToolReceiptSchema).default([]),
  }),
  z.object({
    status: z.literal("failed"),
    step_id: z.string().min(1),
    failure: FailureReportSchema,
  }),
]);
export type StepResult = z.infer<typeof StepResultSchema>;

// ── Mission / system state (pure types; the graph annotation wraps these) ─────

export const MISSION_STATUSES = [
  "planning",
  "executing",
  "awaiting_approval",
  "synthesizing",
  "done",
  "failed",
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export interface Mission {
  goal: string;
  status: MissionStatus;
  plan: Plan | null;
  cursor: number;
}

export interface TurnRecord {
  id: string;
  chat_id: string;
  received_at: string;
  raw_input: string;
}

export interface SystemState {
  schema_version: typeof KERNEL_SCHEMA_VERSION;
  turn: TurnRecord;
  mission: Mission;
  results: StepResult[];
  failure: FailureReport | null;
}

// ── Total validators (never throw) ────────────────────────────────────────────

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function zodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function validatePlan(input: unknown): Validation<Plan> {
  const res = PlanSchema.safeParse(input);
  return res.success ? { ok: true, value: res.data } : { ok: false, error: `Invalid plan — ${zodIssues(res.error)}` };
}

export function validateEnvelope(input: unknown): Validation<TaskEnvelope> {
  const res = TaskEnvelopeSchema.safeParse(input);
  return res.success
    ? { ok: true, value: res.data }
    : { ok: false, error: `Invalid envelope — ${zodIssues(res.error)}` };
}

/**
 * Validate a StepResult AGAINST ITS ENVELOPE:
 *  - structural schema,
 *  - step_id must match,
 *  - ok-output must satisfy expected.schema_ref,
 *  - action steps (expected.kind === "action_receipt") must carry ≥1 successful
 *    ToolReceipt — a claimed action with no receipt is a deterministic failure.
 *    This is the zero-hallucination mechanism; it replaces the regex lie detector.
 */
export function validateStepResult(input: unknown, envelope: TaskEnvelope): Validation<StepResult> {
  const res = StepResultSchema.safeParse(input);
  if (!res.success) return { ok: false, error: `Invalid step result — ${zodIssues(res.error)}` };
  const result = res.data;
  if (result.step_id !== envelope.step_id) {
    return { ok: false, error: `Step id mismatch — result "${result.step_id}" vs envelope "${envelope.step_id}".` };
  }
  if (result.status === "failed") return { ok: true, value: result };

  const outputSchema = OUTPUT_CONTRACTS[envelope.expected.schema_ref]!;
  const out = outputSchema.safeParse(result.output);
  if (!out.success) {
    return {
      ok: false,
      error: `Output does not satisfy "${envelope.expected.schema_ref}" — ${zodIssues(out.error)}`,
    };
  }
  if (envelope.expected.kind === "action_receipt" && !result.tool_receipts.some((r) => r.ok)) {
    return {
      ok: false,
      error: `Action step "${envelope.step_id}" claims success but has no successful tool receipt — refusing unproven action claims.`,
    };
  }
  return { ok: true, value: { ...result, output: out.data } };
}

// Signal contracts re-exported so the kernel registry is the single import point.
export {
  SIGNAL_EVENT_TYPES,
  SIGNAL_CONTRACTS,
  isSignalEventType,
  validateSignalPayload,
  type SignalEventType,
  type SignalPayloadFor,
  type ContractValidation,
} from "./signals.js";
