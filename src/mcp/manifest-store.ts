/**
 * FounderOS — bridge manifest writer (ADR-041 Tier 3)
 * ====================================================
 * The write side of `/connect`: add a server entry to `mcp-bridge.json` on disk,
 * validating the whole manifest afterwards so a bad entry never lands. Reading +
 * validating already lives in bridge-manifest.ts; this only mutates the file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { bridgeManifestSchema, mcpServerSchema, type McpServerEntry } from "./bridge-manifest.js";

export interface AddResult {
  added: boolean;
  /** Present when added is false — why (duplicate key, validation error). */
  reason?: string;
}

/** Load the raw manifest object, tolerating a missing file (→ empty). */
function loadRaw(path: string): { servers: Record<string, unknown> } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { servers: {} };
  }
  const parsed = JSON.parse(text) as { servers?: Record<string, unknown> };
  return { servers: parsed.servers ?? {} };
}

/**
 * Add `entry` under `key` in the manifest at `path`. Refuses to overwrite an
 * existing key (the founder must remove it first) and validates the entry +
 * whole manifest before writing, so `/connect` can never corrupt the file.
 */
export function addServerToManifest(path: string, key: string, entry: McpServerEntry): AddResult {
  const one = mcpServerSchema.safeParse(entry);
  if (!one.success) {
    return { added: false, reason: `invalid server entry: ${one.error.issues.map((i) => i.message).join("; ")}` };
  }

  const raw = loadRaw(path);
  if (raw.servers[key]) return { added: false, reason: `a server named "${key}" is already in the manifest` };

  const next = { servers: { ...raw.servers, [key]: entry } };
  const whole = bridgeManifestSchema.safeParse(next);
  if (!whole.success) {
    return { added: false, reason: `manifest would be invalid: ${whole.error.issues.map((i) => i.message).join("; ")}` };
  }

  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { added: true };
}
