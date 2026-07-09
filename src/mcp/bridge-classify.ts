/**
 * FounderOS — External MCP Tool Classification (ADR-041)
 * ======================================================
 * The single safety-critical decision in the bridge: is an external MCP tool a
 * WRITE (must pass HITL approval) or a READ (passes straight through)?
 *
 * Deterministic and explicit by design (rule #13/#16): a tool is a write ONLY
 * if its bare name is listed in that server's manifest `write` array. Unknown
 * servers and unlisted tools fail SAFE — treated read-only is the *less*
 * dangerous default ONLY because reads cannot mutate; the real guard is that an
 * unknown server contributes no tools at all (see client.ts). Here we simply
 * answer the gating question for a tool we've already chosen to expose.
 */

import type { BridgeManifest } from "./bridge-manifest.js";

/**
 * True when `toolName` (the bare MCP tool name) is gated for `serverName`.
 * Unknown server or unlisted tool → false (read-through).
 */
export function isWriteTool(
  serverName: string,
  toolName: string,
  manifest: BridgeManifest,
): boolean {
  const entry = manifest.servers[serverName];
  if (!entry) return false;
  if (entry.write.includes(toolName)) return true;
  // Defense-in-depth: a server may opt into gating every unlisted tool, so an
  // omitted write name fails toward "require approval" instead of "ungated".
  return entry.gateUnlisted;
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
