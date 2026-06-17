/**
 * FounderOS — Office state slices (P3 hierarchy)
 * ==============================================
 * Typed handoff channels cross graph boundaries. Each slice declares only the
 * keys a nested supervisor needs — never the full company context (ADR-030,
 * CLAUDE rule #21).
 */

/** Schema version for EngineeringHandoff payloads (bump on shape change). */
export const ENGINEERING_HANDOFF_SCHEMA_VERSION = 1 as const;

export type EngineeringHandoffSchemaVersion = typeof ENGINEERING_HANDOFF_SCHEMA_VERSION;
