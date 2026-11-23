/**
 * Mac worker entry (issue #1324). Runs on the founder's Mac, never on the VPS.
 *
 *   node --import tsx/esm scripts/mac-worker.ts            dry run (default): fills forms, never clicks Submit
 *   node --import tsx/esm scripts/mac-worker.ts --live     real submits (only after the founder approves)
 *   node --import tsx/esm scripts/mac-worker.ts --once     handle at most one idle poll, then exit
 *
 * Env: MAC_WORKER_TOKEN (bearer), MAC_WORKER_URL (VPS base URL), MAC_WORKER_CDP (default http://127.0.0.1:9222),
 * AUTO_APPLY_DAILY_CAP (default 10). Setup: scripts/mac-worker/README.md.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMacClient } from "../src/gateway/mac-worker-client.js";
import { connectChrome, openMacSession } from "../src/gateway/mac-worker-browser.js";
import { runWorker, type LoopDeps } from "../src/gateway/mac-worker-loop.js";
import { dailyCapFrom } from "../src/tools/jobhunt/auto-send-rules.js";

const args = new Set(process.argv.slice(2));
const live = args.has("--live") && !args.has("--dry-run");
const once = args.has("--once");

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`mac-worker: ${name} is not set`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const api = createMacClient(need("MAC_WORKER_URL"), need("MAC_WORKER_TOKEN"));
  const browser = await connectChrome(process.env["MAC_WORKER_CDP"] ?? "http://127.0.0.1:9222");
  const cvDir = join(tmpdir(), "founderos-mac-worker");
  await mkdir(cvDir, { recursive: true });
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void (stopping = true));
  const log = (msg: string): void => console.log(`${new Date().toISOString()} mac-worker ${live ? "LIVE" : "dry-run"} ${msg}`);

  let idlePolls = 0;
  const deps: LoopDeps = {
    api, live, dailyCap: dailyCapFrom(), sentToday: 0, log,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    writeCv: async (packet, bytes) => {
      const path = join(cvDir, packet.cv.filename);
      await writeFile(path, bytes);
      return path;
    },
    openSession: (packet, cvPath) => openMacSession(browser, packet, cvPath),
    stop: () => stopping || (once && idlePolls++ > 0),
  };
  log("started");
  await runWorker(deps);
  await browser.close();
}

main().catch((err: unknown) => {
  console.error(`mac-worker: ${(err as Error).message}`);
  process.exit(1);
});
