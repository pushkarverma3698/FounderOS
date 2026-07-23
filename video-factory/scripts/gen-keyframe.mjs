#!/usr/bin/env node
/**
 * Video Factory — Nano Banana keyframe generator (the cheap "draft" stage).
 *
 * Produces ONE art-directed still per shot; Kling then animates it
 * (image-to-video). This is the reference-image conditioning the audit (F8)
 * found missing — a text prompt is no longer the entire art direction.
 *
 * Cost is ~$0.01 (draft) / ~$0.134 (pro), so iterating the frame is cheap
 * while the paid animate step stays gated behind it (Gate 2 in the plan).
 *
 * Idempotent (F4): if <out> already exists the script exits 0 without spending.
 * Fails loud on a wrong-orientation frame so we never animate a mis-framed
 * still (a wasted Kling clip).
 *
 * Usage:
 *   node scripts/gen-keyframe.mjs --prompt "..." --out <file.png>
 *     [--aspect 16:9|9:16] [--model gemini-3.1-flash-image] [--seed 12345]
 */

import { writeFileSync, existsSync } from "node:fs";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const prompt = arg("prompt");
const out = arg("out");
if (!prompt || !out) {
  console.error("Required: --prompt <text> --out <file.png>");
  process.exit(1);
}
if (existsSync(out)) {
  console.log(`exists, skipping (idempotent): ${out}`);
  process.exit(0);
}
const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) not set — keyframe generation is a paid feature.");
  process.exit(1);
}
const model = arg("model", "gemini-3.1-flash-image");
const aspect = arg("aspect", "16:9");
const seed = arg("seed");

const headers = { "x-goog-api-key": apiKey, "Content-Type": "application/json" };
const generationConfig = { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect } };
if (seed !== undefined) generationConfig.seed = Number(seed);

const res = await fetch(`${BASE}/models/${model}:generateContent`, {
  method: "POST",
  headers,
  body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
});
if (!res.ok) {
  console.error(`keyframe generation failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const data = await res.json();
const parts = data.candidates?.[0]?.content?.parts ?? [];
const image = parts.find((p) => p.inlineData?.data)?.inlineData;
if (!image) {
  console.error(`no image in response: ${JSON.stringify(data.candidates?.[0] ?? data)}`);
  process.exit(1);
}
const buf = Buffer.from(image.data, "base64");
writeFileSync(out, buf);

// Best-effort orientation guard: PNG dims live at bytes 16..24 (big-endian).
// If the frame's orientation contradicts the target aspect, fail before Kling
// spends on animating a mis-framed still.
if (buf.length > 24 && buf.toString("ascii", 1, 4) === "PNG") {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const wantLandscape = aspect === "16:9";
  if (w > 0 && h > 0 && wantLandscape !== w >= h) {
    console.error(`keyframe orientation ${w}x${h} contradicts aspect ${aspect} — refusing to animate a mis-framed still.`);
    process.exit(1);
  }
  console.log(`saved ${out} (${w}x${h}, ${aspect}, ${model})`);
} else {
  console.log(`saved ${out} (${aspect}, ${model}${seed !== undefined ? `, seed ${seed}` : ""})`);
}
