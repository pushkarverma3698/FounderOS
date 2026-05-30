#!/usr/bin/env node
/**
 * patch-env.mjs — writes/updates key=value pairs in .env
 * Usage: GOOGLE_KEY=xxx OPENROUTER_KEY=yyy node scripts/patch-env.mjs
 * Keys are read from process.env so they never appear in .env as plaintext commands.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");

let content = "";
try { content = readFileSync(envPath, "utf8"); } catch { /* .env might not exist yet */ }

const lines = content.split("\n");

function upsert(lines, key, value) {
  if (!value) return lines; // skip if not provided
  const idx = lines.findIndex(l => l.startsWith(key + "="));
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
  return lines;
}

const patches = {
  GOOGLE_GENERATIVE_AI_API_KEY: process.env["GOOGLE_KEY"],
  OPENROUTER_API_KEY:           process.env["OR_KEY"],
  TELEGRAM_BOT_TOKEN:           process.env["TG_TOKEN"],
  LM_STUDIO_URL:                process.env["LM_URL"],
  LM_STUDIO_MODEL:              process.env["LM_MODEL"],
};

let updated = lines;
for (const [envKey, val] of Object.entries(patches)) {
  updated = upsert(updated, envKey, val);
}

writeFileSync(envPath, updated.join("\n"));
console.log("✅ .env patched. Keys updated:", Object.keys(patches).filter(k => patches[k]).join(", "));
