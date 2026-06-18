"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/gateway-url";
import { SESSION_ID, type MissionRow, type StreamEvent } from "@/lib/jarvis-api";

export interface ChatLine {
  id: string;
  type: "user" | "assistant" | "system" | "tool" | "error";
  text: string;
  ts: string;
}

export interface HitlPending {
  title: string;
  summary: string;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function handleStreamPayload(
  payload: StreamEvent,
  pushLine: (type: ChatLine["type"], text: string) => void,
  setters: {
    setPendingHitl: (v: HitlPending | null) => void;
    setActiveDept: (v: string | null) => void;
    refreshMissions: () => void;
  },
  onAssistantReply?: (text: string) => void,
): void {
  if (payload.type === "hitl.pending") {
    setters.setPendingHitl({
      title: String(payload.data?.title ?? "Approval required"),
      summary: String(payload.data?.summary ?? payload.data?.preview ?? ""),
    });
    return;
  }

  if (payload.type === "turn.error") {
    const msg = String(payload.data?.message ?? payload.data?.kind ?? "Office run failed");
    pushLine("error", msg);
    return;
  }

  if (payload.type === "turn.complete") {
    setters.setPendingHitl(null);
    const reply =
      payload.data?.reply ??
      payload.data?.replyHtml ??
      payload.data?.replyPreview;
    if (reply) {
      const text = stripHtml(String(reply));
      if (text) {
        pushLine("assistant", text);
        onAssistantReply?.(text);
      }
    }
    return;
  }

  if (payload.type === "department.routed") {
    const hint = String(payload.data?.hint ?? "");
    const dept = hint.split(/\s+/)[0]?.toLowerCase() ?? null;
    setters.setActiveDept(dept);
    if (hint) pushLine("system", `Routed → ${hint}`);
    return;
  }

  if (payload.type === "mission.updated") {
    void setters.refreshMissions();
    return;
  }

  if (payload.type === "tool.start" || payload.type === "tool.end") {
    const status = payload.data?.status ?? payload.data?.notice;
    if (status) {
      pushLine("system", stripHtml(String(status)));
      return;
    }
    pushLine("tool", JSON.stringify(payload.data ?? {}));
  }
}

export function useJarvisStream(onAssistantReply?: (text: string) => void) {
  const [connected, setConnected] = useState(false);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [missions, setMissions] = useState<MissionRow[]>([]);
  const [pendingHitl, setPendingHitl] = useState<HitlPending | null>(null);
  const [activeDept, setActiveDept] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAssistantReplyRef = useRef(onAssistantReply);
  onAssistantReplyRef.current = onAssistantReply;

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
    const res = await fetch(apiUrl("/api/v1/missions"));
    if (!res.ok) return;
    const data = (await res.json()) as { missions: MissionRow[] };
    setMissions(data.missions ?? []);
  }, []);

  const markBusy = useCallback(() => {
    setBusy(true);
    if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
    busyTimerRef.current = setTimeout(() => setBusy(false), 120_000);
  }, []);

  const markIdle = useCallback(() => {
    if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
    busyTimerRef.current = null;
    setBusy(false);
  }, []);

  useEffect(() => {
    void refreshMissions();

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let backoffMs = 1000;

    const connect = () => {
      if (closed) return;
      es?.close();
      const streamUrl = apiUrl(`/api/v1/sessions/${SESSION_ID}/stream`);
      es = new EventSource(streamUrl);

      es.onopen = () => {
        setConnected(true);
        backoffMs = 1000;
      };

      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) {
          reconnectTimer = setTimeout(connect, backoffMs);
          backoffMs = Math.min(backoffMs * 2, 15_000);
        }
      };

      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data) as StreamEvent;
          handleStreamPayload(
            payload,
            pushLine,
            { setPendingHitl, setActiveDept, refreshMissions },
            (text) => onAssistantReplyRef.current?.(text),
          );
          if (payload.type === "turn.complete" || payload.type === "turn.error") {
            markIdle();
          }
        } catch {
          pushLine("system", ev.data);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [markIdle, pushLine, refreshMissions]);

  return {
    connected,
    busy,
    lines,
    missions,
    pendingHitl,
    activeDept,
    listening,
    setListening,
    pushLine,
    refreshMissions,
    setPendingHitl,
    markBusy,
    markIdle,
  };
}
