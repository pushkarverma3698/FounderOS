import { streamUrl } from "./api.js";

export type StreamHandler = (payload: { type: string; data?: Record<string, unknown> }) => void;

/** All stream event types the backend may emit (named SSE `event:` or default message). */
const STREAM_EVENT_TYPES = [
  "department.routed",
  "tool.start",
  "tool.end",
  "hitl.pending",
  "turn.complete",
  "mission.updated",
  "turn.error",
] as const;

export interface OfficeStreamOptions {
  sessionId: string;
  onEvent: StreamHandler;
  onConnected: () => void;
  onDisconnected: () => void;
}

const MAX_BACKOFF_MS = 30_000;

/** EventSource with exponential backoff reconnect. */
export function connectOfficeStream(opts: OfficeStreamOptions): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let backoff = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    es?.close();
    es = new EventSource(streamUrl(opts.sessionId));
    es.onopen = () => {
      backoff = 1000;
      opts.onConnected();
    };
    es.onerror = () => {
      opts.onDisconnected();
      es?.close();
      es = null;
      if (closed) return;
      timer = setTimeout(() => {
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        connect();
      }, backoff);
    };
    const dispatch = (raw: string) => {
      try {
        const payload = JSON.parse(raw) as { type: string; data?: Record<string, unknown> };
        opts.onEvent(payload);
      } catch {
        opts.onEvent({ type: "system", data: { raw } });
      }
    };
    es.onmessage = (ev) => dispatch(ev.data);
    for (const eventType of STREAM_EVENT_TYPES) {
      es.addEventListener(eventType, (ev) => dispatch((ev as MessageEvent).data));
    }
  }

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
