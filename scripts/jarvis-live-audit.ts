/**
 * Live Jarvis audit probe — exercises real chat + SSE on running backend.
 */
import { writeFileSync } from "node:fs";

const BASE = process.env["JARVIS_AUDIT_BASE"] ?? "http://127.0.0.1:3001";
const SESSION = "jarvis-desktop";
const OUT = "/tmp/jarvis-live-audit.json";

type Event = { type: string; data?: Record<string, unknown>; ts?: string };

const events: Event[] = [];
let turnComplete = false;
let turnError = false;
let reply = "";
let errorMsg = "";

async function readSse(url: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`SSE failed: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const block of parts) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const raw = dataLine.slice(5).trim();
      try {
        const payload = JSON.parse(raw) as Event;
        events.push({ ...payload, ts: new Date().toISOString() });
        console.log(`[jarvis-audit] event: ${payload.type}`);
        if (payload.type === "turn.complete") {
          turnComplete = true;
          reply = String(payload.data?.reply ?? payload.data?.replyHtml ?? "");
        }
        if (payload.type === "turn.error") {
          turnError = true;
          errorMsg = String(payload.data?.message ?? payload.data?.error ?? "turn.error");
        }
      } catch {
        /* ignore */
      }
    }
  }
}

async function main(): Promise<void> {
  const ac = new AbortController();
  const ssePromise = readSse(`${BASE}/api/v1/sessions/${SESSION}/stream`, ac.signal);

  await new Promise((r) => setTimeout(r, 1500));

  const task = "Reply with exactly: JARVIS AUDIT OK — one line only, no tools.";
  console.log("[jarvis-audit] POST:", task);
  const res = await fetch(`${BASE}/api/v1/sessions/${SESSION}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: task }),
  });
  console.log("[jarvis-audit] POST status:", res.status);

  const deadline = Date.now() + 90_000;
  while (!turnComplete && !turnError && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  ac.abort();
  await ssePromise.catch(() => {});

  const audit = await fetch(`${BASE}/api/v1/audit?limit=5`).then((r) => r.json());
  const health = await fetch(`${BASE}/health`).then((r) => r.json());

  const result = {
    timestamp: new Date().toISOString(),
    base: BASE,
    session: SESSION,
    postStatus: res.status,
    turnComplete,
    turnError,
    reply,
    errorMsg,
    eventCount: events.length,
    eventTypes: [...new Set(events.map((e) => e.type))],
    events,
    health,
    audit,
  };

  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log("[jarvis-audit] Wrote", OUT);
  console.log("[jarvis-audit] reply:", reply || errorMsg || "(none)");
  process.exit(turnComplete ? 0 : 1);
}

main().catch((err) => {
  console.error("[jarvis-audit] FATAL", err);
  process.exit(1);
});
