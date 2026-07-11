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
