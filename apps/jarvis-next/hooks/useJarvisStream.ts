"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/gateway-url";
import { SESSION_ID, type MissionRow, type StreamEvent } from "@/lib/jarvis-api";
import {
  type CorePhase,
  nextCorePhase,
  VERIFY_SETTLE_MS,
  THINKING_TIMEOUT_MS,
} from "@/lib/core-phase";

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
  onEvent?: (type: string, data?: any) => void,
): void {
  onEvent?.(payload.type, payload.data);

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
    const toolName =
      payload.data?.tool ?? payload.data?.name ?? payload.data?.toolName;
    if (toolName) {
      const verb = payload.type === "tool.start" ? "Invoking" : "Completed";
      pushLine("tool", `${verb}: ${String(toolName)}`);
      return;
    }
    // Silently drop internal telemetry blobs (model, textLen, etc.)
  }
}

export function useJarvisStream(
  onAssistantReply?: (text: string) => void,
  onEvent?: (type: string, data?: any) => void,
) {
  const [connected, setConnected] = useState(false);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [missions, setMissions] = useState<MissionRow[]>([]);
  const [pendingHitl, setPendingHitl] = useState<HitlPending | null>(null);
  const [activeDept, setActiveDept] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [phase, setPhase] = useState<CorePhase>("idle");
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAssistantReplyRef = useRef(onAssistantReply);
  onAssistantReplyRef.current = onAssistantReply;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

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

  const clearTimers = useCallback(() => {
    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    safetyTimerRef.current = null;
    settleTimerRef.current = null;
  }, []);

  const markBusy = useCallback(() => {
    clearTimers();
    setPhase((p) => nextCorePhase(p, "send"));
    safetyTimerRef.current = setTimeout(
      () => setPhase((p) => nextCorePhase(p, "reset")),
      THINKING_TIMEOUT_MS,
    );
  }, [clearTimers]);

  const markIdle = useCallback(() => {
    clearTimers();
    setPhase((p) => nextCorePhase(p, "reset"));
  }, [clearTimers]);

  /** Completion → short "verifying" beat → settle back to idle. */
  const enterVerifying = useCallback(() => {
    clearTimers();
    setPhase((p) => nextCorePhase(p, "turn_complete"));
    settleTimerRef.current = setTimeout(
      () => setPhase((p) => nextCorePhase(p, "settle")),
      VERIFY_SETTLE_MS,
    );
  }, [clearTimers]);

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
            (type, data) => onEventRef.current?.(type, data),
          );
          if (payload.type === "turn.complete") {
            enterVerifying();
          } else if (payload.type === "turn.error") {
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
  }, [enterVerifying, markIdle, pushLine, refreshMissions]);

  return {
    connected,
    phase,
    busy: phase === "thinking",
    verifying: phase === "verifying",
    awaitingApproval: pendingHitl !== null,
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
