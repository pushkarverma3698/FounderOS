/**
 * FounderOS — External MCP Bridge Manifest (ADR-041)
 * ===================================================
 * Declares which external MCP servers FounderOS agents may consume, which
 * department carries each server's tools, and — critically — the explicit
 * per-server `write` allowlist that decides which tools must pass through the
 * HITL approval gate. Classification is data, not a heuristic (rule #13/#16):
 * a tool is a write ONLY if its bare name appears in that server's `write` list.
 *
 * Secrets never live here. `env` lists the NAMES of process env vars to forward
 * to the child server process; values are read from process.env at connect time.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

/** One external MCP server entry. */
export const mcpServerSchema = z.object({
  /** Transport — only stdio is supported today (local child process). */
  transport: z.literal("stdio").default("stdio"),
  /** Executable to spawn (e.g. "uvx", "npx"). */
  command: z.string().min(1),
  /** Arguments passed to the executable. */
  args: z.array(z.string()).default([]),
  /** Names of process env vars to forward to the child (secrets stay out of the manifest). */
  env: z.array(z.string()).default([]),
  /** Department(s) that receive this server's tools. */
  department: z.union([z.string(), z.array(z.string())]),
  /** Explicit allowlist of tool names that require HITL approval. Everything
   *  else is treated read-only and passes straight through. */
  write: z.array(z.string()).default([]),
  /** Defense-in-depth (review M4): when true, ANY tool not in `write` is also
   *  gated — "unknown ⇒ require approval" instead of "unknown ⇒ read-through".
   *  Default false honours the explicit-allowlist contract; flip it on for a
   *  server whose tool surface you don't fully trust to enumerate. */
  gateUnlisted: z.boolean().default(false),
});

export type McpServerEntry = z.infer<typeof mcpServerSchema>;

/** The full bridge manifest. */
export const bridgeManifestSchema = z.object({
  servers: z.record(z.string(), mcpServerSchema).default({}),
});

export type BridgeManifest = z.infer<typeof bridgeManifestSchema>;

/** Normalise a server's `department` field to an array. */
export function departmentsOf(entry: McpServerEntry): string[] {
  return Array.isArray(entry.department) ? entry.department : [entry.department];
}

/**
 * Load and validate the bridge manifest from disk. Throws a clear error on a
 * missing file or a schema violation — fail fast at boot, never mid-request.
 */
export function loadManifest(path: string): BridgeManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `MCP bridge manifest not found at "${path}": ${(err as Error).message}. ` +
        `Set MCP_BRIDGE_MANIFEST or disable MCP_BRIDGE_ENABLED.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`MCP bridge manifest at "${path}" is not valid JSON: ${(err as Error).message}`);
  }

  const result = bridgeManifestSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`❌ MCP bridge manifest validation failed (${path}):\n${issues}`);
  }
  return result.data;
}
