/**
 * FounderOS — MISO Mission Control
 * =================================
 * Mission Inline Skill Orchestration: deterministic mission lifecycle +
 * unified Telegram dashboard format (OpenClaw MISO skill spec).
 *
 * Pure formatting + phase transitions — no grammy imports.
 */

import type { Mission, MissionPhase } from "../db/schema.js";
import type { Seam } from "../infra/trace.js";
import { ROUTABLE_DEPARTMENTS, type RoutableDepartment } from "./dept-routing.js";

/** Single source of truth for department ids — mirrors office sub-agents (dept-routing.ts). */
export const DEPARTMENTS = ROUTABLE_DEPARTMENTS;

export type DepartmentId = RoutableDepartment;

/** Emoji reactions per MISO spec. */
export const PHASE_REACTION: Record<MissionPhase, string> = {
  INIT: "🔥",
  RUNNING: "🔥",
  PARTIAL: "🔥",
  "AWAITING APPROVAL": "👀",
  COMPLETE: "🎉",
  ERROR: "❌",
  CANCELLED: "🚫",
};

export interface MissionView {
  missionId: string;
  title: string;
  owner: string;
  issueRef?: string | null;
  goal: string;
  phase: MissionPhase;
  department?: string | null;
  nextAction?: string | null;
  agentStatuses: Record<string, string>;
  elapsedMs: number;
  doneAgents: number;
  totalAgents: number;
}

export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function missionToView(row: Mission, now = Date.now()): MissionView {
  const started = row.started_at ? new Date(row.started_at).getTime() : now;
  const rawStatuses = row.agent_statuses ?? {};
  // Merge onto the full department roster so the dashboard always shows all
  // 8 departments — not just the ones touched so far — with the rest "idle".
  const statuses: Record<string, string> = {};
  for (const d of DEPARTMENTS) statuses[d] = rawStatuses[d] ?? "idle";
  const entries = Object.entries(statuses);
  const doneAgents = entries.filter(([, s]) => /done|complete|idle|error|cancelled/i.test(s)).length;
  const totalAgents = entries.length;
  return {
    missionId: row.mission_id,
    title: row.goal.slice(0, 60),
    owner: row.owner,
    issueRef: row.issue_ref,
    goal: row.goal,
    phase: row.phase as MissionPhase,
    department: row.department,
    nextAction: row.next_action,
    agentStatuses: statuses,
    elapsedMs: now - started,
    doneAgents,
    totalAgents,
  };
}

/** MISO plain-text dashboard (no code blocks — mobile chat-list optimized). */
export function formatMisoDashboard(view: MissionView): string {
  const lines: string[] = [
    "🤖 MISSION CONTROL",
    "——————————————",
    `📋 ${view.title}`,
    `⏱ ${formatElapsed(view.elapsedMs)} | 🧩 ${view.doneAgents}/${view.totalAgents} agents | ${view.phase}`,
    "",
  ];
  if (view.issueRef) lines.push(`- Issue: #${view.issueRef}`);
  lines.push(`- Owner: ${view.owner}`);
  lines.push(`- Goal: ${view.goal}`);
  lines.push("");

  for (const [agent, status] of Object.entries(view.agentStatuses)) {
    lines.push(`↳ ${agent}: ${status}`);
  }

  lines.push("");
  lines.push(`- Next: ${view.nextAction ?? "awaiting input"}`);
  lines.push("——————————————");
  lines.push("🌸 powered by FounderOS");
  return lines.join("\n");
}

export function formatMisoPlan(goal: string): string {
  return (
    `🤖 MISSION CONTROL — Plan\n` +
    `——————————————\n` +
    `Goal: ${goal}\n\n` +
    `Execution plan:\n` +
    `1. issue-analysis — classify scope and department\n` +
    `2. agent-execution — route to supervisor → department\n` +
    `3. verify — HITL gate before external sends\n` +
    `4. close — summary + action_log audit\n` +
    `——————————————\n` +
    `🌸 powered by FounderOS`
  );
}

export function formatMisoClose(summary: {
  implemented: string;
  validation: string;
  changes: string;
  risks: string;
}): string {
  return (
    `🤖 MISSION CONTROL — Closed\n` +
    `——————————————\n` +
    `- Implemented: ${summary.implemented}\n` +
    `- Validation: ${summary.validation}\n` +
    `- Changes: ${summary.changes}\n` +
    `- Risks / next steps: ${summary.risks}\n` +
    `——————————————\n` +
    `🌸 powered by FounderOS`
  );
}

/** Map trace seams → MISO phase transitions. */
export function phaseFromTrace(seam: Seam, data?: Record<string, unknown>): MissionPhase | null {
  switch (seam) {
    case "turn.in":
      return "RUNNING";
    case "route.decided":
      return "RUNNING";
    case "tool.call":
      return "PARTIAL";
    case "hitl.interrupt":
      return "AWAITING APPROVAL";
    case "turn.out":
      return data?.rejected ? "CANCELLED" : "COMPLETE";
    case "turn.error":
      return "ERROR";
    default:
      return null;
  }
}

export function nextActionFromTrace(seam: Seam, data?: Record<string, unknown>): string | null {
  switch (seam) {
    case "route.decided":
      return `routed — ${String(data?.hint ?? "supervisor").slice(0, 80)}`;
    case "hitl.interrupt":
      return `approval required — ${String(data?.title ?? "HITL")}`;
    case "turn.out":
      return data?.rejected ? "mission cancelled by founder" : "turn complete";
    case "turn.error":
      return "error — check logs";
    default:
      return null;
  }
}

export function departmentFromRouteHint(hint: string): string | null {
  const lower = hint.toLowerCase();
  for (const d of DEPARTMENTS) {
    if (lower.includes(d)) return d;
  }
  return null;
}
