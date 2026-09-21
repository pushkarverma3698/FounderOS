/**
 * FounderOS — Worker Tool Manifest
 * ==================================
 * Derives a scoped tool manifest from the ToolRegistry, filtered by a worker's
 * contract capabilities and permissions. The runtime receives ONLY this manifest
 * — never the full registry.
 *
 * No transport details leak into the manifest. The manifest contains what the
 * runtime needs to know: tool identity, schema, side effects, and approval
 * requirements. HOW tools execute is owned by ToolGateway + adapters.
 */

import type { ToolDefinition } from "../../tools/registry/types.js";
import type { ToolRegistry } from "../../tools/registry/registry.js";
import type { CapabilityResolver } from "./resolver.js";
import type { WorkerContract } from "../contracts/types.js";

// ── Manifest entry (transport-free) ──────────────────────────────────────────

export interface ToolManifestEntry {
  /** Tool identifier (matches ToolDefinition.id). */
  id: string;
  /** Human-readable tool name. */
  name: string;
  /** Tool description for the runtime/model. */
  description: string;
  /** Input schema — what arguments the tool accepts. */
  inputSchema: ToolDefinition["inputSchema"];
  /** Side effect classification. */
  sideEffect: ToolDefinition["sideEffect"];
  /** Whether this tool requires HITL approval. */
  approval: ToolDefinition["approval"];
}

// ── Worker tool manifest ─────────────────────────────────────────────────────

export interface WorkerToolManifest {
  /** Worker this manifest was built for. */
  workerId: string;
  /** Contract version at manifest build time. */
  contractVersion: string;
  /** Scoped tools the worker may invoke. */
  tools: ToolManifestEntry[];
  /** Capability identifiers that were requested but had no mapping. */
  unmappedCapabilities: string[];
  /** Tool IDs that were resolved but not found in the registry. */
  missingToolIds: string[];
}

/**
 * Build a scoped tool manifest for a worker.
 *
 * Flow:
 * 1. Worker contract declares capabilities (e.g. "career.discovery").
 * 2. CapabilityResolver maps capabilities → tool IDs.
 * 3. Worker permissions filter out denied capabilities.
 * 4. ToolRegistry provides definitions for each resolved tool ID.
 * 5. Only enabled tools are included.
 * 6. Transport details are stripped — manifest is runtime-portable.
 *
 * Pure function — no side effects, no I/O.
 */
export function buildWorkerToolManifest(
  contract: WorkerContract,
  registry: ToolRegistry,
  resolver: CapabilityResolver,
): WorkerToolManifest {
  // 1. Find which capabilities have no mapping (informational, not an error)
  const unmappedCapabilities = contract.capabilities.filter(
    (cap) => !resolver.hasMapping(cap),
  );

  // 2. Resolve capabilities → tool IDs, respecting permissions
  const resolvedToolIds = resolver.resolveWithPermissions(
    contract.capabilities,
    contract.permissions,
  );

  // 3. Look up each tool in the registry, filtering disabled tools
  const tools: ToolManifestEntry[] = [];
  const missingToolIds: string[] = [];

  for (const toolId of resolvedToolIds) {
    const def = registry.getTool(toolId) ?? registry.getToolById(toolId);
    if (!def) {
      missingToolIds.push(toolId);
      continue;
    }
    if (!def.enabled) continue;

    tools.push({
      id: def.id,
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      sideEffect: def.sideEffect,
      approval: def.approval,
    });
  }

  return {
    workerId: contract.worker.id,
    contractVersion: contract.worker.contractVersion,
    tools,
    unmappedCapabilities,
    missingToolIds,
  };
}
