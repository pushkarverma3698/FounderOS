/**
 * FounderOS — lenient coercion of worker output into contract shape
 * =================================================================
 * Each function here runs as a Zod `preprocess` step in front of one entry of
 * OUTPUT_CONTRACTS. They exist because a model asked for `{ summary }` will
 * sometimes hand back `{ text }`, or a bare string, and rejecting that costs a
 * whole retry to fix a synonym.
 *
 * THE LINE THESE MUST NOT CROSS. Coercion may RENAME or WRAP a value the worker
 * actually produced. It may never invent one. Nothing here supplies a default,
 * a placeholder or an empty string — a missing field stays missing and fails
 * validation loudly, because a fabricated field is indistinguishable from a real
 * one downstream and that is precisely what the contract layer exists to stop.
 *
 * Split out of contracts.ts: the contracts are the architecture, and these are
 * tolerance for how models phrase themselves. Keeping them separate keeps the
 * contract file readable as a spec.
 */

export function coerceTextSummary(val: unknown): unknown {
  if (typeof val === "string") return { text: val };
  if (val && typeof val === "object" && !Array.isArray(val) && !("text" in val)) {
    const summary = (val as Record<string, unknown>)["summary"];
    if (typeof summary === "string") return { text: summary };
  }
  return val;
}

export function coerceResearchFindings(val: unknown): unknown {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if ("text" in obj && !("summary" in obj) && typeof obj.text === "string") {
      return { ...obj, summary: obj.text };
    }
  }
  return val;
}

export function coerceLinkedinPost(val: unknown): unknown {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if ("text" in obj && !("body" in obj) && typeof obj.text === "string") {
      return { ...obj, body: obj.text };
    }
  }
  return val;
}

export function coerceActionSummary(val: unknown): unknown {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if ("text" in obj && !("summary" in obj) && typeof obj.text === "string") {
      return { ...obj, summary: obj.text };
    }
  }
  return val;
}

export function coerceDataGeneric(val: unknown): unknown {
  if (typeof val === "string") return { data: val };
  if (val && typeof val === "object" && !Array.isArray(val)) return val;
  return val;
}
