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

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
}

function deptFromEvent(data?: Record<string, unknown>): DepartmentId | null {
  const direct = String(data?.department ?? "").toLowerCase();
  if ((DEPARTMENTS as readonly string[]).includes(direct)) return direct as DepartmentId;
  const lower = String(data?.hint ?? "").toLowerCase();
  for (const d of DEPARTMENTS) {
    if (lower === d || lower.includes(d)) return d;
  }
  return null;
}

export interface OfficeStreamOptions {
  onAssistantReply?: (text: string) => void;
}

export function useOfficeStream(sessionId: string, options: OfficeStreamOptions = {}) {
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [activeDept, setActiveDept] = useState<DepartmentId | null>(null);
  const [pendingHitl, setPendingHitl] = useState<PendingHitl | null>(null);
  const [missionTick, setMissionTick] = useState(0);
  const [auditTick, setAuditTick] = useState(0);

  const onReplyRef = useRef(options.onAssistantReply);
  onReplyRef.current = options.onAssistantReply;

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
    if (type === "stream.connected") {
      setConnected(true);
      return;
    }
    if (type === "system.notice") {
      const notice = stripHtml(String(data?.notice ?? ""));
      if (notice) pushLine(data?.voice ? "user" : "system", notice, data);
      return;
    }
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
      if (reply) {
        const text = String(reply);
        pushLine("assistant", text);
        onReplyRef.current?.(text);
      }
      const toolErrors = data?.toolErrors;
      if (Array.isArray(toolErrors) && toolErrors.length > 0) {
        pushLine("error", toolErrors.map(String).join("\n"));
      }
      setAuditTick((n) => n + 1);
    }
    if (type === "turn.error") {
      pushLine("error", String(data?.message ?? data?.error ?? "Turn failed"));
    }
    if (type === "department.routed") {
      const dept = deptFromEvent(data);
      if (dept) setActiveDept(dept);
      const label = dept ?? String(data?.department ?? data?.hint ?? "supervisor");
      pushLine("system", `Routed → ${label}`);
    }
    if (type === "mission.updated") {
      setMissionTick((n) => n + 1);
    }
    if (type === "tool.start" || type === "tool.end") {
      if (data?.notice) return;
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
