/** FounderOS v3 kernel: inter-agent contract schemas. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { SIGNAL_CONTRACTS } from "./signals.js";
import {
  EXPECTED_KINDS,
  kindFromSchemaRef,
  repairEnvelopeExpected,
  repairEnvelopeConstraints,
  type ExpectedKind,
} from "./envelope-repair.js";

export {
  EXPECTED_KINDS,
  kindFromSchemaRef,
  repairEnvelopeConstraints,
  DEFAULT_STEP_MAX_TOOL_CALLS,
  type ExpectedKind,
} from "./envelope-repair.js";
export const KERNEL_SCHEMA_VERSION = 1 as const;

// ── Workers ──────────────────────────────────────────────────────────────────
export const WORKERS = [
  "admin", "research", "comms", "engineering", "marketing", "sales", "personal", "jobhunt",
] as const;
export type WorkerId = (typeof WORKERS)[number];
export const WorkerIdSchema = z.enum(WORKERS);

// ── Failure Report ───────────────────────────────────────────────────────────
export const FAILURE_STAGES = [
  "validation", "planning", "routing", "tool", "model", "budget", "timeout", "hitl_rejected",
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

export const FailureReportSchema = z.object({
  step_id: z.string().min(1),
  stage: z.enum(FAILURE_STAGES),
  component: z.string().min(1),
  message: z.string().min(1),
  evidence: z.string().optional(),
  retryable: z.boolean(),
});
export type FailureReport = z.infer<typeof FailureReportSchema>;

// ── Tool Receipts ────────────────────────────────────────────────────────────
export const ToolReceiptSchema = z.object({
  tool: z.string().min(1),
  args_hash: z.string().length(64),
  result_digest: z.string().length(64),
  ok: z.boolean(),
  at: z.string().datetime(),
  idempotency_key: z.string().optional(),
});
export type ToolReceipt = z.infer<typeof ToolReceiptSchema>;

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashToolArgs(args: unknown): string {
  return sha256Hex(stableStringify(args));
}

export function digestToolResult(result: unknown): string {
  return sha256Hex(typeof result === "string" ? result : stableStringify(result));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

function coerceTextSummary(val: unknown): unknown {
  if (typeof val === "string") return { text: val };
  if (val && typeof val === "object" && !Array.isArray(val) && !("text" in val)) {
    const summary = (val as Record<string, unknown>)["summary"];
    if (typeof summary === "string") return { text: summary };
  }
  return val;
}

function coerceResearchFindings(val: unknown): unknown {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if ("text" in obj && !("summary" in obj) && typeof obj.text === "string") {
      return { ...obj, summary: obj.text };
    }
  }
  return val;
}

function coerceLinkedinPost(val: unknown): unknown {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if ("text" in obj && !("body" in obj) && typeof obj.text === "string") {
      return { ...obj, body: obj.text };
    }
  }
  return val;
}

function coerceActionSummary(val: unknown): unknown {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if ("text" in obj && !("summary" in obj) && typeof obj.text === "string") {
      return { ...obj, summary: obj.text };
    }
  }
  return val;
}

function coerceDataGeneric(val: unknown): unknown {
  if (typeof val === "string") return { data: val };
  if (val && typeof val === "object" && !Array.isArray(val)) return val;
  return val;
}

export const OUTPUT_CONTRACTS: Record<string, z.ZodTypeAny> = {
  "text.summary": z.preprocess(coerceTextSummary, z.object({ text: z.string().min(1) })),
  "research.findings": z.preprocess(
    coerceResearchFindings,
    z.object({
      summary: z.string().min(1),
      sources: z.array(z.object({ title: z.string().min(1), url: z.string().url().optional() })).default([]),
    })
  ),
  "draft.email": z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  "draft.linkedin_post": z.preprocess(coerceLinkedinPost, z.object({ body: z.string().min(1) })),
  "action.summary": z.preprocess(coerceActionSummary, z.object({ summary: z.string().min(1) })),
  "data.generic": z.preprocess(coerceDataGeneric, z.record(z.unknown())),
  ...Object.fromEntries(Object.entries(SIGNAL_CONTRACTS).map(([k, v]) => [`signal.${k}`, v])),
};

export function isOutputSchemaRef(ref: string): boolean {
  return Object.prototype.hasOwnProperty.call(OUTPUT_CONTRACTS, ref);
}

export function repairTextSummaryOutput(parsed: unknown, rawText: string): unknown {
  if (OUTPUT_CONTRACTS["text.summary"]!.safeParse(parsed).success) return parsed;
  return rawText.trim().length > 0 ? { text: rawText } : parsed;
}

export function repairDataGenericOutput(parsed: unknown, rawText: string): unknown {
  if (OUTPUT_CONTRACTS["data.generic"]!.safeParse(parsed).success) return parsed;
  return rawText.trim().length > 0 ? { data: rawText } : parsed;
}

export function getSchemaTemplate(ref: string): string {
  switch (ref) {
    case "text.summary": return `{\n  "text": "string (the main summary/answer)"\n}`;
    case "research.findings": return `{\n  "summary": "string (main research findings)",\n  "sources": [\n    { "title": "string (source title)", "url": "string (optional URL)" }\n  ]\n}`;
    case "draft.email": return `{\n  "to": "string (email address)",\n  "subject": "string",\n  "body": "string"\n}`;
    case "draft.linkedin_post": return `{\n  "body": "string (post text)"\n}`;
    case "action.summary": return `{\n  "summary": "string (summary of action done)"\n}`;
    case "data.generic": return `{\n  "key": "value (freeform JSON)"\n}`;
    default:
      if (ref.startsWith("signal.")) {
        const signalKey = ref.slice(7);
        const contract = (SIGNAL_CONTRACTS as any)[signalKey];
        if (contract instanceof z.ZodObject) {
          const shape = contract.shape;
          const fields = Object.entries(shape).map(([k, v]) => {
            let typeStr = "unknown";
            if (v instanceof z.ZodString) typeStr = "string";
            else if (v instanceof z.ZodNumber) typeStr = "number";
            else if (v instanceof z.ZodBoolean) typeStr = "boolean";
            else if (v instanceof z.ZodArray) typeStr = "array";
            else if (v instanceof z.ZodOptional) typeStr = "optional";
            return `  "${k}": "${typeStr}"`;
          });
          return `{\n${fields.join(",\n")}\n}`;
        }
      }
      return `{}`;
  }
}

export function repairWrappedOutput(parsed: unknown, ref: string): unknown {
  const schema = OUTPUT_CONTRACTS[ref];
  if (!schema || schema.safeParse(parsed).success) return parsed;

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const parts = ref.split(".");
    const possibleWrapKeys = [ref, ref.replace(".", "_"), parts[0], parts[1]].filter((x): x is string => !!x);

    for (const wrapKey of possibleWrapKeys) {
      if (wrapKey in obj && obj[wrapKey] && typeof obj[wrapKey] === "object" && !Array.isArray(obj[wrapKey])) {
        const candidate = obj[wrapKey];
        if (schema.safeParse(candidate).success) return candidate;
      }
    }

    for (const wrapKey of possibleWrapKeys) {
      if (wrapKey in obj && obj[wrapKey] && typeof obj[wrapKey] === "object" && !Array.isArray(obj[wrapKey])) {
        return obj[wrapKey];
      }
    }
  }

  return parsed;
}

// ── Task envelope (the ONLY thing a worker sees) ──────────────────────────────

export const MAX_TOOL_CALLS_PER_STEP = 6;
export const MAX_PLAN_STEPS = 8;

export const TaskEnvelopeSchema = z.preprocess(
  // Fill dropped `constraints` (weak-model failure) before field validation.
  repairEnvelopeConstraints,
  z.object({
    step_id: z.string().min(1),
    worker: WorkerIdSchema,
    /** Explicit statement of the task — the planner may not delegate by vibes. */
    objective: z.string().min(8),
    /** Named inputs; values are prior step outputs referenced by the planner. */
    inputs: z.record(z.unknown()).default({}),
    expected: z.preprocess(
      (val) => repairEnvelopeExpected(val, isOutputSchemaRef),
      z.object({
        kind: z.enum(EXPECTED_KINDS),
        schema_ref: z.string().refine(isOutputSchemaRef, { message: "unknown output schema_ref" }),
      }),
    ),
    dependencies: z.array(z.string()).optional(),
    constraints: z.object({
      max_tool_calls: z.number().int().min(1).max(MAX_TOOL_CALLS_PER_STEP),
      hitl_required: z.boolean(),
    }),
  }),
);
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

// ── Cross-turn conversation memory ─────────────────────────────────────────────
// One compact record per COMPLETED turn, accumulated in the thread's checkpoint
// (Postgres in prod) and replayed to the planner so follow-ups like "send it"
// resolve against real prior turns instead of failing cold.

export const TURN_OUTCOMES = ["replied", "done", "failed"] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export const TurnSummarySchema = z.object({
  turn_id: z.string().min(1),
  at: z.string(),
  user_input: z.string(),
  goal: z.string(),
  outcome: z.enum(TURN_OUTCOMES),
  /** Final founder-facing reply (truncated) — includes failure evidence on failed turns. */
  reply: z.string(),
});
export type TurnSummary = z.infer<typeof TurnSummarySchema>;

export interface SystemState {
  schema_version: typeof KERNEL_SCHEMA_VERSION;
  turn: TurnRecord;
  mission: Mission;
  results: StepResult[];
  failure: FailureReport | null;
}

// ── Validators ────────────────────────────────────────────────────────────────

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

/** Validate StepResult against envelope schema and receipts. */
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
