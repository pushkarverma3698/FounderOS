/**
 * FounderOS — Gateway SSE Stream Hub
 * ===================================
 * In-process pub/sub for web gateway SSE clients. One topic per session id.
 */

import { EventEmitter } from "node:events";

export type StreamEventType =
  | "stream.connected"
  | "system.notice"
  | "department.routed"
  | "tool.start"
  | "tool.end"
  | "hitl.pending"
  | "turn.complete"
  | "mission.updated"
  | "turn.error";

export interface StreamEvent {
  type: StreamEventType;
  sessionId: string;
  ts: string;
  data?: Record<string, unknown>;
}

const hubs = new Map<string, EventEmitter>();

function hubFor(sessionId: string): EventEmitter {
  let hub = hubs.get(sessionId);
  if (!hub) {
    hub = new EventEmitter();
    hub.setMaxListeners(50);
    hubs.set(sessionId, hub);
  }
  return hub;
}

export function publishStreamEvent(sessionId: string, event: Omit<StreamEvent, "sessionId" | "ts">): void {
  const payload: StreamEvent = {
    ...event,
    sessionId,
    ts: new Date().toISOString(),
  };
  hubFor(sessionId).emit("event", payload);
}

export function subscribeStreamEvents(
  sessionId: string,
  onEvent: (ev: StreamEvent) => void,
): () => void {
  const hub = hubFor(sessionId);
  hub.on("event", onEvent);
  return () => hub.off("event", onEvent);
}

/** Test seam — drop all hubs between tests. */
export function resetStreamHubs(): void {
  hubs.clear();
}
