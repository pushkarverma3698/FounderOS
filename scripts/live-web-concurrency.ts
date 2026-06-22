/**
 * LIVE paid concurrency + SSE proof for the JARVIS web gateway.
 *
 * Boots the REAL web app (real office → real Postgres checkpointer → real
 * Gemini) on a spare port, opens one SSE stream for a session, then fires TWO
 * concurrent POST /messages on the SAME session. With the per-session lock now
 * inside runOfficeSession, the two turns must SERIALIZE (no checkpoint race) and
 * both must return a correct, distinct reply over the default `message` SSE frame.
 *
 *   node --env-file=.env --import tsx/esm scripts/live-web-concurrency.ts
 */
import { createServer } from "node:http";
import { createWebApp } from "../src/gateway/web.js";

const PORT = 3997;
const SID = `live-conc-${Date.now()}`;
const app = createWebApp();

const server = createServer(async (req, res) => {
  const request = new Request(`http://127.0.0.1:${PORT}${req.url ?? "/"}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body:
      req.method !== "GET" && req.method !== "HEAD"
        ? await new Promise<Buffer>((resolve) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c as Buffer));
            req.on("end", () => resolve(Buffer.concat(chunks)));
          })
        : undefined,
  });
  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
});

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`[live-conc] gateway on :${PORT}, session=${SID}`);

  // 1) Open the SSE stream and collect turn.complete replies.
  // NOTE: Hono streamSSE withholds response headers until the first event, so
  // `await fetch(stream)` would hang until a frame exists. The subscription is
  // registered the moment the GET handler runs (inside app.fetch) — BEFORE
  // headers flush — so we kick the consumer off fire-and-forget and post
  // messages without awaiting the stream.
  const replies: { reply: string; at: number; named: boolean }[] = [];
  const started = Date.now();
  let sawNamedEvent = false;
  const consume = async (): Promise<void> => {
    const reader = (await fetch(`http://127.0.0.1:${PORT}/api/v1/sessions/${SID}/stream`)).body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const named = block.split("\n").some((l) => l.startsWith("event:"));
        if (named) sawNamedEvent = true;
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          const ev = JSON.parse(dataLine.slice(5).trim());
          if (ev.type === "turn.complete") {
            replies.push({ reply: ev.data?.reply ?? "", at: Date.now() - started, named });
            console.log(
              `[SSE turn.complete @${Date.now() - started}ms named=${named}] ${(ev.data?.reply ?? "").slice(0, 80)}`,
            );
          }
        } catch {
          /* partial frame */
        }
      }
    }
  };
  void consume().catch((e) => console.error("[consume] err", e));

  await new Promise((r) => setTimeout(r, 700)); // let SSE handler register subscription

  // 2) Fire TWO concurrent same-session messages (distinct, verifiable answers).
  const post = (text: string) =>
    fetch(`http://127.0.0.1:${PORT}/api/v1/sessions/${SID}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => r.json());

  console.log("[live-conc] firing 2 concurrent same-session messages…");
  await Promise.all([
    post("What is the capital of France? Reply with just the city name."),
    post("What is 7 times 8? Reply with just the number."),
  ]);

  // 3) Wait for both replies (real Gemini latency) up to 90s.
  const deadline = Date.now() + 90_000;
  while (replies.length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("\n===== LIVE CONCURRENCY RESULT =====");
  console.log(`replies received: ${replies.length}/2`);
  replies.forEach((r, i) => console.log(`  reply[${i}] @${r.at}ms named=${r.named}: ${r.reply.slice(0, 120)}`));
  const paris = replies.some((r) => /paris/i.test(r.reply));
  const fiftySix = replies.some((r) => /\b56\b/.test(r.reply));
  console.log(`contains "Paris":        ${paris}`);
  console.log(`contains "56":           ${fiftySix}`);
  console.log(`named-event leak (BAD):  ${sawNamedEvent}`);
  const pass = replies.length === 2 && paris && fiftySix && !sawNamedEvent;
  console.log(pass ? "VERDICT: PASS ✅" : "VERDICT: FAIL ❌");

  server.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[live-conc] crashed:", err);
  process.exit(1);
});
