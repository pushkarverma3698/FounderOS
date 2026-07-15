#!/usr/bin/env node
/**
 * Video Factory — Veo 3.1 b-roll generator (Stage 2, paid; requires GEMINI_API_KEY).
 *
 * Async long-running pattern: predictLongRunning → poll → download (Google
 * retains output only ~2 days — always download immediately). Default model is
 * Fast ($0.15/s); pass --model veo-3.1-generate-preview only for hero shots
 * ($0.40/s). All output carries a SynthID watermark — never strip it; disclose
 * AI use in client contracts (see docs/VIDEO-FACTORY.md).
 *
 * Usage:
 *   node scripts/gen-broll.mjs --prompt "Drone shot over a sunlit Bangalore wellness studio, warm tones, cinematic" \
 *     --out projects/<p>/assets/broll_01.mp4 [--aspect 9:16] [--duration 8] [--model veo-3.1-fast-generate-preview]
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) not set — b-roll generation is a paid Stage-2 feature.");
  process.exit(1);
}
const prompt = arg("prompt");
const out = arg("out");
if (!prompt || !out) {
  console.error("Required: --prompt <text> --out <file.mp4>");
  process.exit(1);
}
const model = arg("model", "veo-3.1-fast-generate-preview");
const aspect = arg("aspect", "16:9"); // Veo supports 16:9 and 9:16 only; 1:1 is cropped in post
const duration = Number(arg("duration", "8"));

const headers = { "x-goog-api-key": apiKey, "Content-Type": "application/json" };

const start = await fetch(`${BASE}/models/${model}:predictLongRunning`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    instances: [{ prompt }],
    parameters: { aspectRatio: aspect, durationSeconds: duration, sampleCount: 1 },
  }),
});
if (!start.ok) {
  console.error(`Veo start failed: ${start.status} ${await start.text()}`);
  process.exit(1);
}
let op = await start.json();
console.log(`operation: ${op.name} (polling every 10s; typical 11s–6min)`);

while (!op.done) {
  await new Promise((r) => setTimeout(r, 10_000));
  const poll = await fetch(`${BASE}/${op.name}`, { headers });
  if (!poll.ok) {
    console.error(`poll failed: ${poll.status} ${await poll.text()}`);
    process.exit(1);
  }
  op = await poll.json();
}

const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
if (!uri) {
  console.error(`no video in response (safety-blocked generations are not charged): ${JSON.stringify(op.response ?? op.error)}`);
  process.exit(1);
}
const dl = await fetch(`${uri}${uri.includes("?") ? "&" : "?"}key=${apiKey}`, { redirect: "follow" });
if (!dl.ok) {
  console.error(`download failed: ${dl.status}`);
  process.exit(1);
}
const { writeFile } = await import("node:fs/promises");
await writeFile(out, Buffer.from(await dl.arrayBuffer()));
console.log(`saved ${out} (${duration}s, ${aspect}, ${model})`);
