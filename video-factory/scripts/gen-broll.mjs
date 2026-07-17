#!/usr/bin/env node
/**
 * Video Factory — Veo 3.1 b-roll generator (paid; requires GEMINI_API_KEY).
 *
 * Hardened per docs/VIDEO-PIPELINE-AUDIT.md:
 *   F2: polling is BOUNDED (--timeout, default 600s) — never an infinite loop.
 *   F3: the operation name is persisted to <out>.op.json the moment the job
 *       starts, so a crashed/killed run RESUMES polling instead of re-billing.
 *   F4: if <out> already exists the script exits 0 without spending — the
 *       receipts layer in produce.mjs decides when regeneration is warranted.
 *   Transient poll errors are tolerated up to 3 consecutive times, then abort
 *   (the op file remains, so a re-run resumes; money is never stranded).
 *
 * All output carries a SynthID watermark — never strip; disclose AI use.
 *
 * Usage:
 *   node scripts/gen-broll.mjs --prompt "..." --out <file.mp4>
 *     [--aspect 16:9|9:16] [--duration 4|6|8] [--model veo-3.1-fast-generate-preview]
 *     [--seed 12345] [--timeout 600]
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const prompt = arg("prompt");
const out = arg("out");
if (!prompt || !out) {
  console.error("Required: --prompt <text> --out <file.mp4>");
  process.exit(1);
}
// Idempotency check BEFORE the key check: replaying a completed step must
// succeed even on a box without credentials.
if (existsSync(out)) {
  console.log(`exists, skipping (idempotent): ${out}`);
  process.exit(0);
}
const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) not set — b-roll generation is a paid feature.");
  process.exit(1);
}
const model = arg("model", "veo-3.1-fast-generate-preview");
const aspect = arg("aspect", "16:9"); // Veo supports 16:9 and 9:16; 1:1 is center-cropped by the compositor
const duration = Number(arg("duration", "8"));
const seed = arg("seed");
const timeoutS = Number(arg("timeout", "600"));
const opFile = `${out}.op.json`;

const headers = { "x-goog-api-key": apiKey, "Content-Type": "application/json" };

let opName;
if (existsSync(opFile)) {
  opName = JSON.parse(readFileSync(opFile, "utf8")).name;
  console.log(`resuming operation from ${opFile}: ${opName} ($0 — already billed)`);
} else {
  const parameters = { aspectRatio: aspect, durationSeconds: duration, sampleCount: 1 };
  if (seed !== undefined) parameters.seed = Number(seed);
  const start = await fetch(`${BASE}/models/${model}:predictLongRunning`, {
    method: "POST",
    headers,
    body: JSON.stringify({ instances: [{ prompt }], parameters }),
  });
  if (!start.ok) {
    console.error(`Veo start failed: ${start.status} ${await start.text()}`);
    process.exit(1);
  }
  const op = await start.json();
  opName = op.name;
  // Persist the paid operation handle BEFORE polling — a crash can no longer strand spend.
  writeFileSync(opFile, JSON.stringify({ name: opName, model, prompt }, null, 2));
  console.log(`operation: ${opName} (bounded poll: every 10s, max ${timeoutS}s)`);
}

const deadline = Date.now() + timeoutS * 1000;
let op = { done: false };
let consecutiveErrors = 0;
while (!op.done) {
  if (Date.now() > deadline) {
    console.error(`timeout after ${timeoutS}s — operation handle kept in ${opFile}; re-run to resume polling (no re-bill).`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 10_000));
  const poll = await fetch(`${BASE}/${opName}`, { headers }).catch((err) => ({ ok: false, status: 0, text: async () => String(err) }));
  if (!poll.ok) {
    consecutiveErrors++;
    console.error(`poll error ${consecutiveErrors}/3: ${poll.status} ${await poll.text()}`);
    if (consecutiveErrors >= 3) {
      console.error(`aborting after 3 consecutive poll failures — ${opFile} kept; re-run to resume.`);
      process.exit(1);
    }
    continue;
  }
  consecutiveErrors = 0;
  op = await poll.json();
}

const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
if (!uri) {
  unlinkSync(opFile); // terminal: nothing to resume (safety-blocked generations are not charged)
  console.error(`no video in response: ${JSON.stringify(op.response ?? op.error)}`);
  process.exit(1);
}
const dl = await fetch(`${uri}${uri.includes("?") ? "&" : "?"}key=${apiKey}`, { redirect: "follow" });
if (!dl.ok) {
  console.error(`download failed: ${dl.status} — ${opFile} kept; re-run to retry the download (no re-bill, ~2-day retention).`);
  process.exit(1);
}
writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
unlinkSync(opFile);
console.log(`saved ${out} (${duration}s, ${aspect}, ${model}${seed !== undefined ? `, seed ${seed}` : ""})`);
