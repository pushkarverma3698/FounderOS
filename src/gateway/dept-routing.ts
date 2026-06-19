/**
 * Pure helpers for department routing observability (Jarvis dept rail, eval, traces).
 */

const TRANSFER_PREFIX = "transfer_to_";

/** Routable department ids — mirrors office sub-agents (excludes supervisor). */
export const ROUTABLE_DEPARTMENTS = [
  "admin",
  "research",
  "comms",
  "engineering",
  "marketing",
  "sales",
  "personal",
  "jobhunt",
] as const;

export type RoutableDepartment = (typeof ROUTABLE_DEPARTMENTS)[number];

const ROUTABLE_SET = new Set<string>(ROUTABLE_DEPARTMENTS);

/** Parse `transfer_to_<dept>` supervisor handoff tool names. */
export function departmentFromTransferTool(toolName: string): RoutableDepartment | null {
  const name = toolName.trim();
  if (!name.startsWith(TRANSFER_PREFIX)) return null;
  const target = name.slice(TRANSFER_PREFIX.length);
  return ROUTABLE_SET.has(target) ? (target as RoutableDepartment) : null;
}
