/**
 * FounderOS — Capability Resolver
 * =================================
 * Maps logical capability identifiers (e.g. "career.discovery") to concrete
 * ToolDefinition IDs from the ToolRegistry. The resolver is the bridge between
 * a worker's declared capabilities and the actual tools it may invoke.
 *
 * The ToolRegistry remains the authoritative catalog of all tools.
 * The CapabilityResolver determines "which tools does this capability unlock?"
 * Worker permissions determine "may this worker use this capability?"
 */

import type { WorkerPermissions } from "../contracts/types.js";

export class CapabilityResolver {
  /** capability identifier → tool IDs */
  private mappings = new Map<string, string[]>();

  /** Register a capability → tool mapping. Idempotent — last write wins. */
  registerMapping(capability: string, toolIds: string[]): void {
    this.mappings.set(capability, [...toolIds]);
  }

  /** Bulk-register from a record. */
  registerMappings(mappings: Record<string, string[]>): void {
    for (const [cap, toolIds] of Object.entries(mappings)) {
      this.registerMapping(cap, toolIds);
    }
  }

  /** Get tool IDs for a single capability. Empty array if unmapped. */
  getToolsForCapability(capability: string): string[] {
    return this.mappings.get(capability) ?? [];
  }

  /**
   * Resolve a list of capability identifiers to a deduplicated set of tool IDs.
   * Unmapped capabilities are silently skipped (they may represent future tools).
   */
  resolveCapabilities(capabilities: string[]): string[] {
    const toolIds = new Set<string>();
    for (const cap of capabilities) {
      for (const toolId of this.getToolsForCapability(cap)) {
        toolIds.add(toolId);
      }
    }
    return [...toolIds];
  }

  /**
   * Resolve capabilities filtered by worker permissions.
   *
   * - Denied capabilities are excluded entirely.
   * - Allowed and approvalRequired capabilities are resolved.
   * - The caller receives the tool IDs; approval enforcement happens at
   *   the ToolGateway level (not here).
   */
  resolveWithPermissions(
    capabilities: string[],
    permissions: WorkerPermissions,
  ): string[] {
    const deniedSet = new Set(permissions.denied);
    const permittedCapabilities = capabilities.filter(
      (cap) => !deniedSet.has(cap),
    );
    return this.resolveCapabilities(permittedCapabilities);
  }

  /** Check whether a specific capability is mapped. */
  hasMapping(capability: string): boolean {
    return this.mappings.has(capability);
  }

  /** Return all registered capability identifiers. */
  listCapabilities(): string[] {
    return [...this.mappings.keys()];
  }

  /** Return the full mapping table (for debugging / manifests). */
  getMappings(): ReadonlyMap<string, string[]> {
    return this.mappings;
  }
}

/** Global singleton — populated by capability mapping modules at boot. */
export const capabilityResolver = new CapabilityResolver();
