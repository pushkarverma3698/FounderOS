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
    env: process.env,
    shell: process.platform === "win32",
  });
  child.on("exit", (code, signal) => {
    if (signal) console.error(`[${label}] exited (${signal})`);
    else if (code && code !== 0) console.error(`[${label}] exited with code ${code}`);
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
console.log("  Prerequisites: Postgres up, pnpm run setup, .env with GOOGLE_GENERATIVE_AI_API_KEY");
console.log("  Ctrl+C stops both processes.");
console.log("");

run("gateway", "node", ["--env-file=.env", "--import", "tsx/esm", "scripts/dev-jarvis-gateway.ts"]);

setTimeout(() => {
  if (shuttingDown) return;
  run("ui", "pnpm", ["--filter", "founderos-jarvis-next", "dev"]);
}, 2500);
