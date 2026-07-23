#!/usr/bin/env node
/**
 * Video Factory — production executor.
 *
 * Dumb, deterministic runner for the plan compiled by plan_video_production
 * (src/tools/video-production.ts). It contains ZERO creative or routing
 * logic — it replays receipts and executes only steps that are missing,
 * stale, or failed fewer than max_attempts times.
 *
 *   node scripts/produce.mjs --project projects/<p> [--dry-run] [--approve-spend <usd>]
 *
 * Contracts (mirror src/tools/video-production.ts — keep in lockstep):
 *   - receipt key = fnv1a(JSON.stringify({id,kind,params,produces})) hex
 *   - a receipt is valid only if ok && key matches; stale receipts re-run
 *   - failed attempts >= max_attempts → hard stop, component named, exit 1
 *   - paid steps require --approve-spend >= pending estimate (budget gate)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stepKey } from "./lib/step-key.mjs"; // single source of truth (mirrors src/tools/video-production.ts)

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const projectArg = arg("project");
if (!projectArg) {
  console.error("Required: --project projects/<name>");
  process.exit(2);
}
const projectDir = resolve(FACTORY_ROOT, projectArg);
const planFile = join(projectDir, "production.json");
if (!existsSync(planFile)) {
  console.error(`No production.json in ${projectDir} — run plan_video_production first.`);
  process.exit(2);
}
const { plan } = JSON.parse(readFileSync(planFile, "utf8"));
const receiptsDir = join(projectDir, "receipts");
for (const d of ["assets", "assets/vendor", "work", "renders", "receipts"]) mkdirSync(join(projectDir, d), { recursive: true });

function loadReceipts() {
  const map = {};
  for (const f of readdirSync(receiptsDir).filter((f) => f.endsWith(".json"))) {
    try {
      const r = JSON.parse(readFileSync(join(receiptsDir, f), "utf8"));
      if (r.step_id) map[r.step_id] = r;
    } catch {
      /* unreadable receipt = no receipt; the step simply re-runs */
    }
  }
  return map;
}

function writeReceipt(receipt) {
  const tmp = join(receiptsDir, `.${receipt.step_id}.tmp`);
  writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  renameSync(tmp, join(receiptsDir, `${receipt.step_id}.json`)); // atomic checkpoint
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function ffprobe(file) {
  const res = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height,codec_type", "-of", "json", file], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`ffprobe failed on ${file}: ${res.stderr?.trim()}`);
  const data = JSON.parse(res.stdout);
  const video = (data.streams ?? []).find((s) => s.codec_type === "video");
  return { duration_s: Number(data.format?.duration ?? 0), width: video?.width, height: video?.height };
}

function run(cmd, argv, opts = {}) {
  const res = spawnSync(cmd, argv, { cwd: projectDir, stdio: "inherit", ...opts });
  if (res.error) throw new Error(`${cmd} failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} exited ${res.status}`);
}

function executeStep(step) {
  const p = step.params;
  switch (step.kind) {
    case "copy": {
      const from = resolve(FACTORY_ROOT, p.from);
      if (!existsSync(from)) throw new Error(`copy source missing: ${p.from} — run npm install in video-factory/`);
      copyFileSync(from, join(projectDir, p.to));
      return;
    }
    case "veo":
      run("node", [
        join(FACTORY_ROOT, "scripts", "gen-broll.mjs"),
        "--prompt", p.prompt,
        "--out", join(projectDir, step.produces),
        "--aspect", p.aspect,
        "--duration", String(p.duration_s),
        "--model", p.model,
        "--seed", String(p.seed),
      ]);
      return;
    case "keyframe":
      run("node", [
        join(FACTORY_ROOT, "scripts", "gen-keyframe.mjs"),
        "--prompt", p.prompt,
        "--out", join(projectDir, step.produces),
        "--aspect", p.aspect,
        "--model", p.model,
        "--seed", String(p.seed),
      ]);
      return;
    case "kling": {
      const outPath = join(projectDir, step.produces);
      run("node", [
        join(FACTORY_ROOT, "scripts", "gen-kling.mjs"),
        "--prompt", p.prompt,
        "--image", join(projectDir, p.image),
        "--out", outPath,
        "--aspect", p.aspect,
        "--duration", String(p.duration_s),
        "--model", p.model,
        "--seed", String(p.seed),
        "--fallback-model", p.fallback_model,
        "--fallback-duration", String(p.fallback_duration_s),
      ]);
      // gen-kling.mjs records which engine actually produced the clip so a
      // Kling→Veo fallback is auditable in the receipt (never silent).
      const engineFile = `${outPath}.engine.json`;
      let engine_used = "kling";
      if (existsSync(engineFile)) {
        try {
          engine_used = JSON.parse(readFileSync(engineFile, "utf8")).engine_used ?? "kling";
        } catch {
          /* sidecar unreadable — default to kling */
        }
        rmSync(engineFile, { force: true });
      }
      return { engine_used };
    }
    case "hyperframes":
      run(join(FACTORY_ROOT, "node_modules", ".bin", "hyperframes"), [
        "render", "-c", p.composition, "-o", step.produces, "--quality", p.quality ?? "standard",
      ]);
      return;
    case "elevenlabs-vo": {
      const voice = process.env.ELEVENLABS_VOICE_ID;
      if (!voice) throw new Error("ELEVENLABS_VOICE_ID not set — pick a voice in the ElevenLabs dashboard and export it.");
      run("node", [
        join(FACTORY_ROOT, "scripts", "gen-voiceover.mjs"),
        "--text", p.text, "--voice", voice, "--out", join(projectDir, step.produces), "--seed", String(p.seed ?? 0),
      ]);
      return;
    }
    case "elevenlabs-music":
      run("node", [
        join(FACTORY_ROOT, "scripts", "gen-music.mjs"),
        "--prompt", p.prompt, "--duration-ms", String(p.duration_ms), "--out", join(projectDir, step.produces),
      ]);
      return;
    case "ffmpeg":
      run("ffmpeg", p.argv);
      return;
    case "probe": {
      const file = join(projectDir, p.file);
      if (!existsSync(file)) throw new Error(`expected artifact missing: ${p.file}`);
      const probe = ffprobe(file);
      if (p.min_duration_s !== undefined && probe.duration_s < p.min_duration_s - 0.05)
        throw new Error(`${p.file}: duration ${probe.duration_s.toFixed(2)}s < required ${p.min_duration_s}s`);
      if (p.max_duration_s !== undefined && probe.duration_s > p.max_duration_s + 0.05)
        throw new Error(`${p.file}: duration ${probe.duration_s.toFixed(2)}s > allowed ${p.max_duration_s}s${p.remedy ? ` — ${p.remedy}` : ""}`);
      if (p.width !== undefined && probe.width !== p.width) throw new Error(`${p.file}: width ${probe.width} ≠ ${p.width}`);
      if (p.height !== undefined && probe.height !== p.height) throw new Error(`${p.file}: height ${probe.height} ≠ ${p.height}`);
      return probe;
    }
    default:
      throw new Error(`unknown step kind "${step.kind}" — plan is newer than this executor`);
  }
}

// ---- main loop: derive → gate spend → execute ready steps in plan order ----
const receipts = loadReceipts();
const done = new Set();
const failedTerminal = [];
let pendingCost = 0;
const pending = [];

for (const step of plan.steps) {
  const r = receipts[step.id];
  const fresh = r && r.key === stepKey(step);
  if (fresh && r.ok) {
    done.add(step.id);
    continue;
  }
  if (fresh && !r.ok && r.attempts >= plan.max_attempts) {
    failedTerminal.push({ step, receipt: r });
    continue;
  }
  pending.push(step);
  pendingCost += step.est_cost_usd ?? 0;
}

if (failedTerminal.length > 0) {
  console.error(`\nHALTED — ${failedTerminal.length} step(s) failed ${plan.max_attempts}x (bounded retries, no loops):`);
  for (const { step, receipt } of failedTerminal) console.error(`  ✗ ${step.id} [${step.kind}]: ${receipt.error}`);
  console.error(`Fix the named component, delete receipts/<step>.json to re-arm, or re-plan.`);
  process.exit(1);
}
if (pending.length === 0) {
  console.log(`Nothing to do — production "${plan.project}" is complete: renders/${plan.project}.mp4`);
  process.exit(0);
}
console.log(`${plan.project}: ${done.size}/${plan.steps.length} steps done, ${pending.length} to run, est pending spend $${pendingCost.toFixed(2)}`);
if (flag("dry-run")) {
  for (const s of pending) console.log(`  would run: ${s.id} [${s.kind}]${s.est_cost_usd ? ` ~$${s.est_cost_usd}` : ""}`);
  process.exit(0);
}
const approved = Number(arg("approve-spend", "0"));
if (pendingCost > 0 && approved + 1e-9 < pendingCost) {
  console.error(`Budget gate: pending steps cost ~$${pendingCost.toFixed(2)} but only $${approved.toFixed(2)} approved.`);
  console.error(`Re-run with --approve-spend ${Math.ceil(pendingCost)} to authorize.`);
  process.exit(2);
}

for (const step of pending) {
  const unmet = step.needs.filter((d) => !done.has(d));
  if (unmet.length > 0) {
    console.error(`\nSTOP at ${step.id}: blocked by ${unmet.join(", ")} (upstream failure this run). Fix and re-run — completed work is checkpointed.`);
    process.exit(1);
  }
  const prev = receipts[step.id];
  const attempts = (prev && prev.key === stepKey(step) ? prev.attempts : 0) + 1;
  console.log(`→ ${step.id} [${step.kind}] (attempt ${attempts}/${plan.max_attempts})`);
  try {
    const result = executeStep(step);
    const receipt = { step_id: step.id, key: stepKey(step), ok: true, attempts };
    if (step.produces) {
      const artifact = join(projectDir, step.produces);
      if (!existsSync(artifact)) throw new Error(`step succeeded but artifact missing: ${step.produces}`);
      receipt.sha256 = sha256(artifact);
    }
    if (result?.engine_used) receipt.engine_used = result.engine_used;
    else if (result) receipt.probe = result;
    writeReceipt(receipt);
    done.add(step.id);
  } catch (err) {
    writeReceipt({ step_id: step.id, key: stepKey(step), ok: false, attempts, error: String(err.message ?? err) });
    console.error(`\n✗ ${step.id} [${step.kind}] failed (attempt ${attempts}/${plan.max_attempts}): ${err.message}`);
    console.error(attempts >= plan.max_attempts ? `Step is now TERMINAL — fix the component, then delete receipts/${step.id}.json.` : `Re-run produce.mjs to retry once more; everything completed is checkpointed.`);
    process.exit(1);
  }
}
console.log(`\n✓ Production complete: ${join(projectArg, "renders", `${plan.project}.mp4`)}`);
