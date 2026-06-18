import { streamUrl } from "./api.js";

export type StreamHandler = (payload: { type: string; data?: Record<string, unknown> }) => void;

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
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as { type: string; data?: Record<string, unknown> };
        opts.onEvent(payload);
      } catch {
        opts.onEvent({ type: "system", data: { raw: ev.data } });
      }
    };
  }

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
