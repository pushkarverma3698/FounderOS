#!/usr/bin/env node
/**
 * Video Factory — ElevenLabs voiceover generator (Stage 2, paid; ELEVENLABS_API_KEY).
 *
 * Rule from the pipeline research: generate AUDIO BEFORE visuals and time the
 * composition to the measured audio duration. Script length is briefed by WORD
 * COUNT (~160 words ≈ 60s) — compile_video_brief already budgets this.
 *
 * eleven_multilingual_v2 = quality pick for Indian-English long-form
 * (commercial license on paid plans). ~$0.10 per 1,000 chars.
 *
 * Usage:
 *   node scripts/gen-voiceover.mjs --text "..." --voice <voice_id> --out projects/<p>/assets/vo.mp3 [--seed 42]
 */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error("ELEVENLABS_API_KEY not set — voiceover is a paid Stage-2 feature.");
  process.exit(1);
}
const text = arg("text");
const voice = arg("voice");
const out = arg("out");
if (!text || !voice || !out) {
  console.error("Required: --text <script> --voice <voice_id> --out <file.mp3>");
  process.exit(1);
}
const { existsSync } = await import("node:fs");
if (existsSync(out)) {
  console.log(`exists, skipping (idempotent): ${out}`);
  process.exit(0);
}

const body = {
  text,
  model_id: arg("model", "eleven_multilingual_v2"),
  voice_settings: { stability: 0.5, similarity_boost: 0.75 },
};
const seed = arg("seed");
if (seed) body.seed = Number(seed);

const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
  method: "POST",
  headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { writeFile } = await import("node:fs/promises");
await writeFile(out, Buffer.from(await res.arrayBuffer()));
console.log(`saved ${out} (${text.split(/\s+/).length} words — time scenes to the MEASURED audio duration, not the estimate)`);
