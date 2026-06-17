"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SESSION_ID, type MissionRow, type StreamEvent } from "@/lib/jarvis-api";

export interface ChatLine {
  id: string;
  type: "user" | "assistant" | "system" | "tool";
  text: string;
  ts: string;
}

export interface HitlPending {
  title: string;
  summary: string;
}

export function useJarvisStream(onAssistantReply?: (text: string) => void) {
  const [connected, setConnected] = useState(false);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [missions, setMissions] = useState<MissionRow[]>([]);
  const [pendingHitl, setPendingHitl] = useState<HitlPending | null>(null);
  const [activeDept, setActiveDept] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  const pushLine = useCallback((type: ChatLine["type"], text: string) => {
    setLines((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${prev.length}`,
        type,
        text,
        ts: new Date().toLocaleTimeString(),
      },
    ]);
  }, []);

  const refreshMissions = useCallback(async () => {
    const res = await fetch("/api/v1/missions");
    if (!res.ok) return;
    const data = (await res.json()) as { missions: MissionRow[] };
    setMissions(data.missions ?? []);
  }, []);

  useEffect(() => {
    void refreshMissions();
    const es = new EventSource(`/api/v1/sessions/${SESSION_ID}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as StreamEvent;
        if (payload.type === "hitl.pending") {
          setPendingHitl({
            title: String(payload.data?.title ?? "Approval required"),
            summary: String(payload.data?.summary ?? ""),
          });
        }
        if (payload.type === "turn.complete") {
          setPendingHitl(null);
          const reply = payload.data?.reply ?? payload.data?.replyHtml;
          if (reply) {
            const text = String(reply);
            pushLine("assistant", text);
            onAssistantReply?.(text);
          }
        }
        if (payload.type === "department.routed") {
          const hint = String(payload.data?.hint ?? "");
          setActiveDept(hint.split(" ")[0]?.toLowerCase() ?? null);
          pushLine("system", `Routed → ${hint}`);
        }
        if (payload.type === "mission.updated") void refreshMissions();
        if (payload.type === "tool.start" || payload.type === "tool.end") {
          pushLine("tool", JSON.stringify(payload.data ?? {}));
        }
      } catch {
        pushLine("system", ev.data);
      }
    };
    return () => es.close();
  }, [onAssistantReply, pushLine, refreshMissions]);

  return {
    connected,
    lines,
    missions,
    pendingHitl,
    activeDept,
    listening,
    setListening,
    pushLine,
    refreshMissions,
    setPendingHitl,
  };
}
