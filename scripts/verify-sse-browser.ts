/**
 * Throwaway browser-SSE verifier — runs the REAL compiled web gateway (web.ts)
 * on a spare port with permissive CORS and publishes a synthetic `turn.complete`
 * frame every 1.5s. A browser EventSource (driven via preview_eval) confirms that
 * `onmessage` now fires — proving the named-event→default-message fix end-to-end.
 *
 *   node --env-file=.env --import tsx/esm scripts/verify-sse-browser.ts
 */
import { createServer } from "node:http";
import { createWebApp } from "../src/gateway/web.js";
import { publishStreamEvent, resetStreamHubs } from "../src/gateway/stream-hub.js";

const PORT = 3996;
const SID = "browser-sse-verify";

resetStreamHubs();
const app = createWebApp();

const server = createServer(async (req, res) => {
  // Permissive CORS so the :3000 page can open a cross-origin EventSource.
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const request = new Request(`http://127.0.0.1:${PORT}${req.url ?? "/"}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
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

server.listen(PORT, () => {
  console.log(`[verify-sse] listening on http://127.0.0.1:${PORT} (session=${SID})`);
  setInterval(() => {
    publishStreamEvent(SID, { type: "turn.complete", data: { reply: "BROWSER-OK" } });
  }, 1500);
});
