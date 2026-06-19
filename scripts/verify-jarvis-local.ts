#!/usr/bin/env node
/**
 * Preflight for pnpm dev:jarvis-local — fails fast with a clear message.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function importGateway(): Promise<void> {
  await import("../src/infra/telemetry.js");
  const { getOffice } = await import("../src/agents/office.js");
  await getOffice();
}

async function waitForHealth(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main(): Promise<void> {
  console.log("verify:jarvis — compiling office graph…");
  await importGateway();
  console.log("verify:jarvis — office OK");

  const gw = spawn("node", ["--env-file=.env", "--import", "tsx/esm", "scripts/dev-jarvis-gateway.ts"], {
    cwd: root,
    stdio: "ignore",
  });

  const up = await waitForHealth(3001, 25_000);
  gw.kill("SIGTERM");

  if (!up) {
    console.error("verify:jarvis — FAIL: gateway did not respond on :3001 within 20s");
    process.exit(1);
  }

  const ui = spawn("pnpm", ["--filter", "founderos-jarvis-next", "build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });

  const code: number = await new Promise((resolve) => ui.on("close", resolve));
  if (code !== 0) {
    console.error("verify:jarvis — FAIL: jarvis-next build exited", code);
    process.exit(code);
  }

  console.log("verify:jarvis — PASS (office + gateway + jarvis-next build)");
}

main().catch((err) => {
  console.error("verify:jarvis — FAIL:", err);
  process.exit(1);
});
