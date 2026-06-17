export const SESSION_ID = "jarvis-cinematic";

export const DEPARTMENTS = [
  { id: "research", label: "Research", color: "#4ef0ff" },
  { id: "comms", label: "Comms", color: "#5cffb0" },
  { id: "engineering", label: "Engineering", color: "#ffc857" },
  { id: "marketing", label: "Marketing", color: "#ff7eb3" },
  { id: "sales", label: "Sales", color: "#a78bfa" },
  { id: "personal", label: "Personal", color: "#7dd3fc" },
  { id: "jobhunt", label: "Jobhunt", color: "#fbbf24" },
] as const;

export interface StreamEvent {
  type: string;
  data?: Record<string, unknown>;
}

export interface MissionRow {
  title: string;
  phase: string;
  goal: string;
  dashboard?: string;
}

export async function sendMessage(text: string): Promise<void> {
  const res = await fetch(`/api/v1/sessions/${SESSION_ID}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status}`);
}

export async function hitlDecision(decision: "approve" | "reject"): Promise<void> {
  const res = await fetch(`/api/v1/sessions/${SESSION_ID}/hitl/${decision}`, { method: "POST" });
  if (!res.ok) throw new Error(`hitl failed: ${res.status}`);
}

export async function fetchMissions(): Promise<MissionRow[]> {
  const res = await fetch("/api/v1/missions");
  if (!res.ok) return [];
  const data = (await res.json()) as { missions: MissionRow[] };
  return data.missions ?? [];
}

export async function createMission(goal: string): Promise<void> {
  const res = await fetch(`/api/v1/sessions/${SESSION_ID}/missions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  if (!res.ok) throw new Error(`mission failed: ${res.status}`);
}
