#!/usr/bin/env node
/**
 * Video Factory — Eleven Music bed generator (paid; ELEVENLABS_API_KEY).
 *
 * Generates an instrumental music bed matched to the shot list's
 * music_direction and exact video length. Idempotent: exits 0 without
 * spending if --out already exists (produce.mjs receipts govern regeneration).
 *
 * License note (docs/VIDEO-FACTORY.md): commercial use on paid plans;
 * broadcast/OTT needs Enterprise; no streaming-platform music distribution.
 *
 * Usage:
 *   node scripts/gen-music.mjs --prompt "ambient meditative, calm" \
 *     --duration-ms 30000 --out projects/<p>/assets/music.mp3
 */

import { writeFileSync, existsSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error("ELEVENLABS_API_KEY not set — music generation is a paid feature (or re-plan with include_music: false).");
  process.exit(1);
}
const prompt = arg("prompt");
const out = arg("out");
const durationMs = Number(arg("duration-ms", "30000"));
if (!prompt || !out) {
  console.error("Required: --prompt <direction> --out <file.mp3> [--duration-ms 30000]");
  process.exit(1);
}
if (existsSync(out)) {
  console.log(`exists, skipping (idempotent): ${out}`);
  process.exit(0);
}

// Eleven Music accepts 10s–5min lengths.
const clamped = Math.min(300_000, Math.max(10_000, Math.round(durationMs)));
const res = await fetch("https://api.elevenlabs.io/v1/music", {
  method: "POST",
  headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, music_length_ms: clamped }),
});
if (!res.ok) {
  console.error(`Eleven Music failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(`saved ${out} (${(clamped / 1000).toFixed(0)}s music bed)`);
