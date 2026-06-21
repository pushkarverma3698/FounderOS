const API_TOKEN = import.meta.env.VITE_WEB_GATEWAY_TOKEN?.trim() ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (API_TOKEN) headers["authorization"] = `Bearer ${API_TOKEN}`;
  return headers;
}

export function streamUrl(sessionId: string): string {
  const base = `/api/v1/sessions/${encodeURIComponent(sessionId)}/stream`;
  if (!API_TOKEN) return base;
  return `${base}?token=${encodeURIComponent(API_TOKEN)}`;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(text || res.statusText, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function sendMessage(sessionId: string, text: string): Promise<void> {
  await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function hitlDecision(sessionId: string, decision: "approve" | "reject"): Promise<void> {
  await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/hitl/${decision}`, {
    method: "POST",
  });
}

export async function fetchMissions(): Promise<{ missions: import("./types.js").MissionRow[] }> {
  return apiFetch("/api/v1/missions");
}

export async function createMission(sessionId: string, goal: string): Promise<{ missionId: string }> {
  return apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/missions`, {
    method: "POST",
    body: JSON.stringify({ goal }),
  });
}

export async function fetchMisoStatus(sessionId: string): Promise<{ status: string }> {
  return apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/miso/status`);
}

export async function fetchMisoPlan(sessionId: string): Promise<{ plan: string }> {
  return apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/miso/plan`);
}

export async function closeMission(sessionId: string): Promise<{ summary: string }> {
  return apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/miso/close`, {
    method: "POST",
  });
}

export async function fetchAudit(): Promise<{ entries: import("./types.js").AuditEntry[] }> {
  return apiFetch("/api/v1/audit");
}

export async function sendVoice(sessionId: string, audio: Blob): Promise<{
  accepted: boolean;
  englishText?: string;
  transcript?: string;
}> {
  const headers: Record<string, string> = { "content-type": audio.type || "audio/webm" };
  if (API_TOKEN) headers["authorization"] = `Bearer ${API_TOKEN}`;
  const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/voice`, {
    method: "POST",
    headers,
    body: audio,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(text || res.statusText, res.status);
  }
  return (await res.json()) as { accepted: boolean; englishText?: string; transcript?: string };
}

export async function fetchTtsAudio(text: string): Promise<Blob> {
  const headers = authHeaders();
  const res = await fetch("/api/v1/tts", {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new ApiError(errText || res.statusText, res.status);
  }
  return res.blob();
}

/** Exported for tests */
export function getApiToken(): string {
  return API_TOKEN;
}
