#!/usr/bin/env node
/**
 * Video Factory — Kling image-to-video generator (primary; via fal.ai).
 *
 * Animates a Nano Banana keyframe into a shot. Kling leads on I2V identity/
 * texture preservation; Veo 3.1 is the automatic FALLBACK so a fal/Kling
 * outage never fails a render. The engine that actually produced the clip is
 * written to <out>.engine.json so produce.mjs can record it in the receipt.
 *
 * Credit-safety (mirrors gen-broll.mjs, audit F2–F4):
 *   F3/F4: the fal request_id is persisted to <out>.op.json BEFORE polling, and
 *          a resumed run RE-POLLS that id — it never resubmits (no double charge).
 *   Transient (5xx/429/network) submit errors get a bounded retry; a terminal
 *   4xx (bad prompt/image) skips straight to the Veo fallback (no wasted retries).
 *   Idempotent: if <out> exists the script exits 0 without spending.
 *
 * Usage:
 *   node scripts/gen-kling.mjs --prompt "..." --image <frame.png> --out <file.mp4>
 *     [--aspect 16:9|9:16] [--duration 5|10] [--model fal-ai/kling-video/...]
 *     [--seed N] --fallback-model veo-3.1-fast-generate-preview --fallback-duration 8
 *     [--timeout 900]
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const prompt = arg("prompt");
const image = arg("image");
const out = arg("out");
if (!prompt || !image || !out) {
  console.error("Required: --prompt <text> --image <frame.png> --out <file.mp4>");
  process.exit(1);
}
if (existsSync(out)) {
  console.log(`exists, skipping (idempotent): ${out}`);
  process.exit(0);
}
const aspect = arg("aspect", "16:9");
const duration = arg("duration", "5"); // Kling grid: "5" or "10"
const model = arg("model", "fal-ai/kling-video/v2.5-turbo/pro/image-to-video");
const fallbackModel = arg("fallback-model", "veo-3.1-fast-generate-preview");
const fallbackDuration = arg("fallback-duration", "8");
const timeoutS = Number(arg("timeout", "900"));
const opFile = `${out}.op.json`;
const engineFile = `${out}.engine.json`;

const writeEngine = (engine_used) => writeFileSync(engineFile, JSON.stringify({ engine_used }, null, 2));

/** Veo 3.1 text-to-video fallback — never fails a render (Kling/fal down). */
function fallbackToVeo(reason) {
  console.error(`Kling unavailable (${reason}) — falling back to Veo 3.1 (text-to-video).`);
  const res = spawnSync(
    "node",
    [
      join(SCRIPTS_DIR, "gen-broll.mjs"),
      "--prompt", prompt,
      "--out", out,
      "--aspect", aspect,
      "--duration", fallbackDuration,
      "--model", fallbackModel,
    ],
    { stdio: "inherit" },
  );
  if (res.status !== 0) {
    console.error("Veo fallback also failed — the render cannot proceed.");
    process.exit(1);
  }
  writeEngine("veo");
  process.exit(0);
}

// v2.6/v3 Kling endpoints name the reference frame start_image_url; earlier ones image_url.
const imageField = /\/v(2\.6|3)\b/.test(model) ? "start_image_url" : "image_url";
const isTransient = (err) => {
  const s = err?.status ?? err?.response?.status ?? 0;
  return s === 0 || s === 429 || (s >= 500 && s < 600);
};

const falKey = process.env.FAL_KEY ?? process.env.FAL_API_KEY;
if (!falKey) fallbackToVeo("FAL_KEY not set");

let fal;
try {
  ({ fal } = await import("@fal-ai/client"));
} catch {
  fallbackToVeo("@fal-ai/client not installed (run npm install in video-factory/)");
}
fal.config({ credentials: falKey });

async function pollUntilVideo(requestId, deadline) {
  let consecutiveErrors = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`timeout after ${timeoutS}s — ${opFile} kept; re-run to resume polling (no re-bill).`);
    try {
      const status = await fal.queue.status(model, { requestId });
      consecutiveErrors = 0;
      if (status.status === "COMPLETED") break;
    } catch (err) {
      if (++consecutiveErrors >= 3) throw err;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  const result = await fal.queue.result(model, { requestId });
  const url = result?.data?.video?.url ?? result?.video?.url;
  if (!url) throw new Error(`no video in fal result: ${JSON.stringify(result?.data ?? result)}`);
  return url;
}

const deadline = Date.now() + timeoutS * 1000;
let requestId;

if (existsSync(opFile)) {
  requestId = JSON.parse(readFileSync(opFile, "utf8")).request_id;
  console.log(`resuming fal request from ${opFile}: ${requestId} ($0 — already submitted)`);
} else {
  // Upload the keyframe once, then submit. On a terminal submit error, fall back.
  let imageUrl;
  try {
    const buf = readFileSync(image);
    imageUrl = await fal.storage.upload(new Blob([buf], { type: "image/png" }));
  } catch (err) {
    fallbackToVeo(`keyframe upload failed: ${err.message ?? err}`);
  }
  const input = { prompt, [imageField]: imageUrl, duration, aspect_ratio: aspect };
  let submitted;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      submitted = await fal.queue.submit(model, { input });
      break;
    } catch (err) {
      if (isTransient(err) && attempt < 2) {
        console.error(`fal submit transient error (attempt ${attempt}/2): ${err.message ?? err} — retrying.`);
        continue;
      }
      fallbackToVeo(`fal submit failed: ${err.message ?? err}`);
    }
  }
  requestId = submitted.request_id;
  // Persist the paid handle BEFORE polling — a crash can no longer strand spend.
  writeFileSync(opFile, JSON.stringify({ request_id: requestId, model, image_url: imageUrl }, null, 2));
  console.log(`fal request: ${requestId} (${model}, bounded poll max ${timeoutS}s)`);
}

let videoUrl;
try {
  videoUrl = await pollUntilVideo(requestId, deadline);
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1); // op file kept — receipts layer retries; resume re-polls, never re-bills.
}

const dl = await fetch(videoUrl, { redirect: "follow" });
if (!dl.ok) {
  console.error(`download failed: ${dl.status} — ${opFile} kept; re-run to retry the download (no re-bill).`);
  process.exit(1);
}
writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
writeEngine("kling");
unlinkSync(opFile);
console.log(`saved ${out} (${duration}s, ${aspect}, ${model})`);
