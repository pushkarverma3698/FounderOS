export const SESSION_ID = "jarvis-desktop";

export const DEPARTMENTS = [
  "research",
  "comms",
  "engineering",
  "marketing",
  "sales",
  "personal",
  "jobhunt",
] as const;

export type DepartmentId = (typeof DEPARTMENTS)[number];

export interface StreamLine {
  id: string;
  type: "user" | "assistant" | "system" | "tool" | "error";
  text: string;
  ts: string;
  meta?: Record<string, unknown>;
}

export interface MissionRow {
  missionId?: string;
  title: string;
  phase: string;
  goal: string;
  dashboard?: string;
}

export interface PendingHitl {
  title: string;
  summary: string;
  preview?: string;
  action?: string;
}

export interface AuditEntry {
  action: string;
  idempotency_key?: string;
  created_at?: string;
  payload?: unknown;
}

export interface StreamEventPayload {
  type: string;
  data?: Record<string, unknown>;
}
