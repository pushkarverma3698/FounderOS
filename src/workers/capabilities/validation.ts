import type { ToolRegistry } from "../../tools/registry/registry.js";
import type { CapabilityResolver } from "./resolver.js";
import type { WorkerContract } from "../contracts/types.js";

/**
 * Validates that every tool ID mapped in the capability resolver exists
 * in the active ToolRegistry and is enabled.
 * 
 * Fails loudly if a capability mapping contains a typo or references
 * a tool that has been removed or disabled.
 */
export function validateCapabilityMappings(
  resolver: CapabilityResolver,
  registry: ToolRegistry,
): void {
  const mappings = resolver.getMappings();
  const errors: string[] = [];

  for (const [capability, toolIds] of mappings.entries()) {
    for (const toolId of toolIds) {
      const toolDef = registry.getTool(toolId);
      if (!toolDef) {
        errors.push(`Capability "${capability}" maps to unknown tool "${toolId}"`);
        continue;
      }
      if (!toolDef.enabled) {
        errors.push(`Capability "${capability}" maps to disabled tool "${toolId}"`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Capability mapping validation failed:\n - ${errors.join("\n - ")}`
    );
  }
}

/**
 * Validates a worker contract's capabilities against the resolver.
 * Ensures the worker is not requesting unmapped capabilities.
 */
export function validateWorkerCapabilities(
  contract: WorkerContract,
  resolver: CapabilityResolver
): void {
  const errors: string[] = [];

  for (const cap of contract.capabilities) {
    if (!resolver.hasMapping(cap)) {
      errors.push(`Worker "${contract.worker.id}" requires unmapped capability "${cap}"`);
    }
  }

  // Also check that allowed/approvalRequired/denied permissions map to valid capabilities
  const checkPerms = (perms: string[], type: string) => {
    for (const cap of perms) {
      if (!resolver.hasMapping(cap)) {
        errors.push(`Worker "${contract.worker.id}" lists unmapped capability "${cap}" in ${type} permissions`);
      }
    }
  };

  checkPerms(contract.permissions.allowed, "allowed");
  checkPerms(contract.permissions.approvalRequired, "approvalRequired");
  checkPerms(contract.permissions.denied, "denied");

  if (errors.length > 0) {
    throw new Error(
      `Worker capability validation failed:\n - ${errors.join("\n - ")}`
    );
  }
}
