import { describe, test, expect } from "vitest";
import { CapabilityResolver } from "../../../src/workers/capabilities/resolver.js";
import { DEFAULT_CAPABILITY_MAPPINGS } from "../../../src/workers/capabilities/mappings.js";
import { validateCapabilityMappings, validateWorkerCapabilities } from "../../../src/workers/capabilities/validation.js";
import { toolRegistry } from "../../../src/tools/registry/registry.js";
import { initializeToolRegistry } from "../../../src/tools/registry/init.js";
import { CAREER_OPERATOR_CONTRACT } from "../../../src/workers/contracts/career-operator.js";

describe("Capability Validation", () => {
  test("DEFAULT_CAPABILITY_MAPPINGS maps to valid tools", () => {
    // 1. Initialize the global tool registry with all stubs
    initializeToolRegistry();

    // 2. Setup the resolver with defaults
    const resolver = new CapabilityResolver();
    resolver.registerMappings(DEFAULT_CAPABILITY_MAPPINGS);

    // 3. Validate - should not throw
    expect(() => validateCapabilityMappings(resolver, toolRegistry)).not.toThrow();
  });

  test("validateCapabilityMappings throws on unknown tool", () => {
    const resolver = new CapabilityResolver();
    resolver.registerMappings({
      "test.cap": ["this_tool_does_not_exist"],
    });

    expect(() => validateCapabilityMappings(resolver, toolRegistry)).toThrowError(
      /Capability "test.cap" maps to unknown tool "this_tool_does_not_exist"/
    );
  });

  test("validateWorkerCapabilities validates career operator against default mappings", () => {
    const resolver = new CapabilityResolver();
    resolver.registerMappings(DEFAULT_CAPABILITY_MAPPINGS);

    // Career operator fixture uses valid capabilities
    expect(() => validateWorkerCapabilities(CAREER_OPERATOR_CONTRACT, resolver)).not.toThrow();
  });

  test("validateWorkerCapabilities throws on unmapped capability", () => {
    const resolver = new CapabilityResolver();
    resolver.registerMappings(DEFAULT_CAPABILITY_MAPPINGS);

    const badContract = {
      ...CAREER_OPERATOR_CONTRACT,
      capabilities: ["some.imaginary.capability"],
    };

    expect(() => validateWorkerCapabilities(badContract, resolver)).toThrowError(
      /requires unmapped capability "some.imaginary.capability"/
    );
  });
});
