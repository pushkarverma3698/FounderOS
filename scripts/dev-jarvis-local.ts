#!/usr/bin/env node
/**
 * Local JARVIS preview — gateway (:3001) + Next.js UI (:3000) on your machine.
 * No Telegram poll (avoids 409 when prod bot is live).
 *
 *   pnpm dev:jarvis-local
 *   → http://localhost:3000
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const children: ChildProcess[] = [];

function run(label: string, command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_PUBLIC_JARVIS_GATEWAY_URL: process.env["NEXT_PUBLIC_JARVIS_GATEWAY_URL"] ?? "http://127.0.0.1:3001",
    },
    shell: process.platform === "win32",
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) console.error(`[${label}] exited (${signal})`);
    else if (code && code !== 0) console.error(`[${label}] exited with code ${code}`);
    // If UI fails because :3000 is taken, keep gateway alive for an existing UI session.
    if (label === "ui" && code === 1) {
      console.error("[ui] Start failed — gateway still on :3001 (stop other Next dev on :3000 or retry UI only)");
      return;
    }
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("");
console.log("  JARVIS local preview");
console.log("  ────────────────────");
console.log("  API  → http://localhost:3001");
console.log("  UI   → http://localhost:3000");
console.log("");
console.log("  Prerequisites: Postgres up, pnpm run setup");
console.log("  Recommended: AGENT_MODEL=google-genai:gemini-2.5-flash + GOOGLE_GENERATIVE_AI_API_KEY");
console.log("  Ctrl+C stops both processes.");
console.log("");

run("gateway", "node", ["--env-file=.env", "--import", "tsx/esm", "scripts/dev-jarvis-gateway.ts"]);

setTimeout(() => {
  if (shuttingDown) return;
  run("ui", "pnpm", ["--filter", "founderos-jarvis-next", "dev"]);
}, 2500);
