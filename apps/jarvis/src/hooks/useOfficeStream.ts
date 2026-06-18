import { useCallback, useEffect, useRef, useState } from "react";
import { connectOfficeStream } from "../lib/sse.js";
import type { DepartmentId, PendingHitl, StreamLine } from "../lib/types.js";
import { DEPARTMENTS } from "../lib/types.js";

function formatToolLine(type: string, data?: Record<string, unknown>): string {
  const name = String(data?.toolName ?? data?.name ?? data?.tool ?? "tool");
  if (type === "tool.start") {
    const status = data?.status ? `: ${String(data.status)}` : "";
    return `▶ ${name}${status}`;
  }
  const ok = data?.ok !== false && !data?.error;
  return `${ok ? "✓" : "✗"} ${name}${data?.error ? `: ${String(data.error)}` : ""}`;
}

function deptFromHint(hint: unknown): DepartmentId | null {
  const lower = String(hint ?? "").toLowerCase();
  for (const d of DEPARTMENTS) {
    if (lower.includes(d)) return d;
  }
  return null;
}

export function useOfficeStream(sessionId: string) {
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [activeDept, setActiveDept] = useState<DepartmentId | null>(null);
  const [pendingHitl, setPendingHitl] = useState<PendingHitl | null>(null);
  const [missionTick, setMissionTick] = useState(0);
  const [auditTick, setAuditTick] = useState(0);

  const pushLine = useCallback((type: StreamLine["type"], text: string, meta?: Record<string, unknown>) => {
    setLines((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${prev.length}`,
        type,
        text,
        ts: new Date().toLocaleTimeString(),
        meta,
      },
    ]);
  }, []);

  const onEventRef = useRef<(payload: { type: string; data?: Record<string, unknown> }) => void>(() => {});

  onEventRef.current = (payload) => {
    const { type, data } = payload;
    if (type === "hitl.pending") {
      setPendingHitl({
        title: String(data?.title ?? "Approval required"),
        summary: String(data?.summary ?? ""),
        preview: data?.preview ? String(data.preview) : undefined,
        action: data?.action ? String(data.action) : undefined,
      });
    }
    if (type === "turn.complete") {
      setPendingHitl(null);
      const reply = data?.reply ?? data?.replyHtml;
      if (reply) pushLine("assistant", String(reply));
      setAuditTick((n) => n + 1);
    }
    if (type === "turn.error") {
      pushLine("error", String(data?.message ?? data?.error ?? "Turn failed"));
    }
    if (type === "department.routed") {
      const dept = deptFromHint(data?.hint ?? data?.department);
      if (dept) setActiveDept(dept);
      pushLine("system", `Routed: ${String(data?.hint ?? data?.department ?? "supervisor")}`);
    }
    if (type === "mission.updated") {
      setMissionTick((n) => n + 1);
    }
    if (type === "tool.start" || type === "tool.end") {
      pushLine("tool", formatToolLine(type, data), data);
    }
  };

  useEffect(() => {
    const disconnect = connectOfficeStream({
      sessionId,
      onConnected: () => setConnected(true),
      onDisconnected: () => setConnected(false),
      onEvent: (p) => onEventRef.current(p),
    });
    return disconnect;
  }, [sessionId]);

  return {
    lines,
    connected,
    activeDept,
    pendingHitl,
    setPendingHitl,
    missionTick,
    auditTick,
    pushLine,
  };
}
