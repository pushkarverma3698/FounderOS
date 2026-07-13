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

/** Fields every server carries regardless of transport — the routing +
 *  safety-classification data the bridge acts on (transport-agnostic). */
const sharedServerFields = {
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
};

/** A local child-process server (blender, npx-launched servers). */
export const stdioServerSchema = z.object({
  transport: z.literal("stdio"),
  /** Executable to spawn (e.g. "uvx", "npx"). */
  command: z.string().min(1),
  /** Arguments passed to the executable. */
  args: z.array(z.string()).default([]),
  /** Names of process env vars to forward to the child (secrets stay out of the manifest). */
  env: z.array(z.string()).default([]),
  ...sharedServerFields,
});

/** A hosted remote server reached over streamable HTTP (the 2026 default:
 *  Notion, Linear, Stripe, DeepWiki, … — no local install). */
export const httpServerSchema = z.object({
  transport: z.literal("http"),
  /** The server's streamable-HTTP endpoint (e.g. "https://mcp.deepwiki.com/mcp"). */
  url: z.string().url(),
  /** Literal, NON-SECRET headers sent verbatim (e.g. an API-version pin). */
  headers: z.record(z.string(), z.string()).default({}),
  /** header name → env-var NAME whose value becomes that header at connect
   *  time. This is the HTTP analogue of stdio `env`: secrets stay out of the
   *  manifest, resolved from process.env only when the connection is opened.
   *  e.g. { "Authorization": "NOTION_MCP_TOKEN" }. */
  headerEnv: z.record(z.string(), z.string()).default({}),
  ...sharedServerFields,
});

/** One external MCP server entry — stdio (local) or http (hosted remote).
 *  The `preprocess` keeps backward-compat: an entry that omits `transport`
 *  still parses as stdio, so pre-http manifests (and their tests) are unchanged. */
export const mcpServerSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) && !("transport" in v) ? { transport: "stdio", ...v } : v),
  z.discriminatedUnion("transport", [stdioServerSchema, httpServerSchema]),
);

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
