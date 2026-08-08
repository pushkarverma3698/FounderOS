/**
 * Planner envelope drift repair — pure preprocess helpers for TaskEnvelope.expected.
 * Extracted from contracts.ts to keep the LOC budget (rule R4).
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

function normalizeExpectedKind(val: unknown): unknown {
  if (!val || typeof val !== "object") return val;
  const o = val as Record<string, unknown>;
  if ((EXPECTED_KINDS as readonly string[]).includes(o["kind"] as string)) return val;
  return { ...o, kind: kindFromSchemaRef(o["schema_ref"]) };
}

function normalizeUnknownSchemaRef(
  val: unknown,
  isKnownSchemaRef: (ref: string) => boolean,
): unknown {
  if (!val || typeof val !== "object") return val;
  const o = val as Record<string, unknown>;
  const ref = o["schema_ref"];
  if (typeof ref !== "string" || ref === "" || isKnownSchemaRef(ref)) return val;
  if (o["kind"] !== "data" || kindFromSchemaRef(ref) !== "data") return val;
  return { ...o, schema_ref: "data.generic" };
}

/** Chain kind repair then unknown data schema_ref repair before Zod parse. */
export function repairEnvelopeExpected(
  val: unknown,
  isKnownSchemaRef: (ref: string) => boolean,
): unknown {
  return normalizeUnknownSchemaRef(normalizeExpectedKind(val), isKnownSchemaRef);
}

/** Safe default tool budget when the planner omits it (mid of the 1–15 range). */
export const DEFAULT_STEP_MAX_TOOL_CALLS = 8;

/**
 * Fill a step's `constraints` when the planner model drops the field or one of
 * its keys — a real weak-model failure mode (live 2026-07-13: gemini/free
 * fallback emitted a step with no `constraints`, failing planner validation
 * with "plan.steps.0.constraints: Required"). Deterministic and model-free:
 *   - max_tool_calls → DEFAULT_STEP_MAX_TOOL_CALLS
 *   - hitl_required  → TRUE for action_receipt steps (fail SAFE: a dropped gate
 *     flag must never auto-approve an external send), FALSE otherwise.
 * A well-formed envelope passes through with identical values (determinism).
 */
export function repairEnvelopeConstraints(val: unknown): unknown {
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  const o = val as Record<string, unknown>;
  const expected = o["expected"];
  const kind = expected && typeof expected === "object" ? (expected as Record<string, unknown>)["kind"] : undefined;
  const schemaRef =
    expected && typeof expected === "object" ? (expected as Record<string, unknown>)["schema_ref"] : undefined;
  const isAction = kind === "action_receipt" || kindFromSchemaRef(schemaRef) === "action_receipt";

  const current = o["constraints"];
  const base =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const needsMax = typeof base["max_tool_calls"] !== "number";
  const needsHitl = typeof base["hitl_required"] !== "boolean";
  if (!needsMax && !needsHitl && current === base) return val; // fully formed — untouched

  return {
    ...o,
    constraints: {
      ...base,
      ...(needsMax ? { max_tool_calls: DEFAULT_STEP_MAX_TOOL_CALLS } : {}),
      ...(needsHitl ? { hitl_required: isAction } : {}),
    },
  };
}
