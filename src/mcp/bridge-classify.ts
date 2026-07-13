/**
 * FounderOS — External MCP Tool Classification (ADR-041)
 * ======================================================
 * The single safety-critical decision in the bridge: is an external MCP tool a
 * WRITE (must pass HITL approval) or a READ (passes straight through)?
 *
 * Deterministic and explicit by design (rule #13/#16): the manifest `write`
 * allowlist is authoritative, and a server's own hints can only ADD a gate,
 * never remove one. Unknown servers and unlisted tools fail SAFE — treated
 * read-only is the *less* dangerous default ONLY because reads cannot mutate;
 * the real guard is that an unknown server contributes no tools at all (see
 * client.ts). Here we simply answer the gating question for a tool we've
 * already chosen to expose.
 *
 * Tier 2 (ADR-041 amendment) adds server-declared MCP tool annotations
 * (spec 2025-06-18) as a SECOND source: a tool the server honestly marks as
 * mutating gets gated even when the founder didn't hand-list it — which lets a
 * well-annotated server drop its `write` list entirely. The spec is explicit
 * that annotations from an untrusted server are hints, not guarantees, so we
 * trust them only to tighten (add a gate), never to loosen (the manifest and
 * `gateUnlisted` still win, and a missing hint keeps the read-through default).
 */

import type { BridgeManifest } from "./bridge-manifest.js";

/** The two MCP tool-annotation hints we act on (spec 2025-06-18). */
export interface ToolAnnotations {
  /** Server asserts the tool does not modify its environment. */
  readOnlyHint?: boolean;
  /** Server asserts the tool may perform destructive updates. */
  destructiveHint?: boolean;
}

/**
 * Extract the two hints we trust off a loaded MCP tool. `@langchain/mcp-adapters`
 * surfaces the server's annotations at `metadata.annotations`. Returns undefined
 * when the server annotated nothing we recognise, so callers can distinguish
 * "declared read-only" from "said nothing".
 */
export function annotationsOf(tool: { metadata?: { annotations?: unknown } }): ToolAnnotations | undefined {
  const a = tool.metadata?.annotations;
  if (!a || typeof a !== "object") return undefined;
  const { readOnlyHint, destructiveHint } = a as ToolAnnotations;
  if (typeof readOnlyHint !== "boolean" && typeof destructiveHint !== "boolean") return undefined;
  return { readOnlyHint, destructiveHint };
}

/**
 * True when `toolName` (the bare MCP tool name) is gated for `serverName`.
 * Precedence (each step can only ADD a gate; none can remove one):
 *   1. listed in the manifest `write` allowlist  → gate (founder override wins)
 *   2. server has `gateUnlisted`                  → gate everything unlisted
 *   3. annotation says destructive / not-read-only → gate (Tier 2)
 *   4. otherwise                                   → read-through
 * Unknown server → false. Pass `annotations` to enable step 3.
 */
export function isWriteTool(
  serverName: string,
  toolName: string,
  manifest: BridgeManifest,
  annotations?: ToolAnnotations,
): boolean {
  const entry = manifest.servers[serverName];
  if (!entry) return false;
  if (entry.write.includes(toolName)) return true;
  // Defense-in-depth: a server may opt into gating every unlisted tool, so an
  // omitted write name fails toward "require approval" instead of "ungated".
  if (entry.gateUnlisted) return true;
  // Tier 2: trust a server's self-declared risk only to ADD a gate. A missing
  // hint preserves the read-through default (unknown ≠ known-safe; the real
  // guard remains that unknown servers contribute no tools at all).
  if (annotations?.destructiveHint === true) return true;
  if (annotations?.readOnlyHint === false) return true;
  return false;
}

/** Deterministic, collision-free runtime name for a bridged tool. */
export function bridgedToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** Runtime names of every HITL-gated bridged tool, derived from the manifest's
 *  write allowlists. Used to mark `*` in the supervisor capability manifest. */
export function gatedRuntimeNames(manifest: BridgeManifest): string[] {
  const names: string[] = [];
  for (const [server, entry] of Object.entries(manifest.servers)) {
    for (const toolName of entry.write) names.push(bridgedToolName(server, toolName));
  }
  return names;
}
