/**
 * FounderOS — Ops Cockpit data assembly (Phase 5)
 * ===============================================
 * Pure, read-only aggregation for the operator cockpit. No side effects, no
 * external writes — just a structured view of the live system topology
 * (departments, hierarchy subgraphs, bridged MCP servers) and cost rollups.
 *
 * Rule #16: deterministic, unit-testable pure functions. The HTTP layer
 * (`web.ts`) and the static UI (`cockpit-ui.ts`) consume these.
 */

import {
  ENGINEERING_SUBGRAPH_ENABLED,
  REVENUE_SUBGRAPH_ENABLED,
  MCP_BRIDGE_MANIFEST,
} from "../core/config.js";
import { loadManifest, departmentsOf } from "../mcp/bridge-manifest.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "cockpit" });

/** The seven LOCKED departments (ADR — architecture is locked). Order is stable. */
export const DEPARTMENT_KEYS = [
  "research",
  "comms",
  "engineering",
  "marketing",
  "sales",
  "personal",
  "jobhunt",
] as const;

export type DepartmentKey = (typeof DEPARTMENT_KEYS)[number];

export interface SubgraphState {
  /** CTO-led engineering sub-supervisor (coder/qa/devops) active. */
  engineering: boolean;
  /** Revenue sub-supervisor (marketing + sales nested) active. */
  revenue: boolean;
}

export interface McpServerView {
  name: string;
  departments: string[];
  /** Count of tools gated behind HITL (the server's write allowlist). */
  writeTools: number;
}

export interface CockpitState {
  departments: DepartmentKey[];
  subgraphs: SubgraphState;
  mcpServers: McpServerView[];
  generatedAt: string;
}

/**
 * Read the bridged MCP servers from the manifest. Read-only and defensive: a
 * missing/invalid manifest yields an empty list (cockpit must never throw —
 * observability surfaces degradation, it does not cause it).
 */
export function listMcpServers(manifestPath = MCP_BRIDGE_MANIFEST): McpServerView[] {
  try {
    const manifest = loadManifest(manifestPath);
    return Object.entries(manifest.servers).map(([name, entry]) => ({
      name,
      departments: departmentsOf(entry),
      writeTools: entry.write?.length ?? 0,
    }));
  } catch (err) {
    log.warn({ err: (err as Error).message }, "cockpit: MCP manifest unavailable");
    return [];
  }
}

export function subgraphState(): SubgraphState {
  return {
    engineering: ENGINEERING_SUBGRAPH_ENABLED,
    revenue: REVENUE_SUBGRAPH_ENABLED,
  };
}

/** Assemble the full topology snapshot for the cockpit state panel. */
export function buildCockpitState(manifestPath = MCP_BRIDGE_MANIFEST): CockpitState {
  return {
    departments: [...DEPARTMENT_KEYS],
    subgraphs: subgraphState(),
    mcpServers: listMcpServers(manifestPath),
    generatedAt: new Date().toISOString(),
  };
}

export interface CostRow {
  model: string | null;
  agent: string | null;
  calls: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: string;
}

export interface CostSummary {
  rows: CostRow[];
  totals: {
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
}

/** Roll cost breakdown rows into headline totals (token + USD observability). */
export function summarizeCost(rows: CostRow[]): CostSummary {
  const totals = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + Number(r.calls ?? 0),
      tokensIn: acc.tokensIn + Number(r.total_tokens_in ?? 0),
      tokensOut: acc.tokensOut + Number(r.total_tokens_out ?? 0),
      costUsd: acc.costUsd + Number(r.total_cost_usd ?? 0),
    }),
    { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
  );
  return { rows, totals };
}
