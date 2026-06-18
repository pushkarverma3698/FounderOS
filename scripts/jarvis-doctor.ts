#!/usr/bin/env node
/**
 * JARVIS doctor — fix common Mac/local blockers and run preflight.
 *
 *   pnpm jarvis:doctor        # check only
 *   pnpm jarvis:doctor --fix  # reset conflicting files, free ports, pull, verify
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fix = process.argv.includes("--fix");

function run(cmd: string, opts: { cwd?: string; ignoreError?: boolean } = {}): string {
  try {
    return execSync(cmd, {
      cwd: opts.cwd ?? root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (opts.ignoreError) return "";
    throw err;
  }
}

function fail(msg: string): never {
  console.error(`\n❌ jarvis:doctor — ${msg}\n`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`✅ ${msg}`);
}

function warn(msg: string): void {
  console.log(`⚠️  ${msg}`);
}

function dirty(file: string): boolean {
  try {
    run(`git diff --quiet -- ${file}`);
    run(`git diff --cached --quiet -- ${file}`);
    return false;
  } catch {
    return true;
  }
}

function killPorts(): void {
  for (const port of [3000, 3001]) {
    try {
      const pids = run(`lsof -ti :${port}`, { ignoreError: true });
      if (!pids) continue;
      for (const pid of pids.split(/\s+/).filter(Boolean)) {
        if (fix) {
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      if (fix && pids) ok(`Freed port ${port}`);
      else if (pids) warn(`Port ${port} in use (pids: ${pids}) — run with --fix`);
    } catch {
      // lsof missing on some systems
    }
  }
}

async function main(): Promise<void> {
  console.log("\n  JARVIS doctor\n  ─────────────");

  const branch = run("git branch --show-current", { ignoreError: true });
  if (branch !== "cursor/jarvis-nextjs-cinematic-ae51") {
    warn(`On branch '${branch || "?"}' — expected cursor/jarvis-nextjs-cinematic-ae51`);
    if (fix) {
      run("git fetch origin cursor/jarvis-nextjs-cinematic-ae51");
      run("git checkout cursor/jarvis-nextjs-cinematic-ae51");
      ok("Checked out cursor/jarvis-nextjs-cinematic-ae51");
    }
  } else {
    ok(`Branch: ${branch}`);
  }

  if (fix) {
    try {
      run("git pull origin cursor/jarvis-nextjs-cinematic-ae51");
      ok("Pulled latest");
    } catch {
      if (dirty("src/agents/agent-tools/rag.ts")) {
        run("git stash push -m 'jarvis-doctor-rag' -- src/agents/agent-tools/rag.ts");
        warn("Stashed local src/agents/agent-tools/rag.ts (conflicted with rag-orchestrator)");
      }
      run("git pull origin cursor/jarvis-nextjs-cinematic-ae51");
      ok("Pulled latest after stash");
    }
  }

  const orchestrator = path.join(root, "src/infra/rag-orchestrator.ts");
  if (!existsSync(orchestrator)) {
    if (fix) {
      fail("rag-orchestrator.ts still missing after pull — run: git pull origin cursor/jarvis-nextjs-cinematic-ae51");
    }
    fail("Missing src/infra/rag-orchestrator.ts — git pull origin cursor/jarvis-nextjs-cinematic-ae51");
  }
  ok("rag-orchestrator.ts present");

  const ragTs = path.join(root, "src/agents/agent-tools/rag.ts");
  const ragSrc = readFileSync(ragTs, "utf8");
  if (!ragSrc.includes("rag-orchestrator")) {
    if (fix && dirty("src/agents/agent-tools/rag.ts")) {
      run("git checkout HEAD -- src/agents/agent-tools/rag.ts");
      ok("Reset src/agents/agent-tools/rag.ts to branch version");
    } else {
      fail("src/agents/agent-tools/rag.ts does not import rag-orchestrator — run: pnpm jarvis:doctor --fix");
    }
  } else if (dirty("src/agents/agent-tools/rag.ts")) {
    warn("Local edits to src/agents/agent-tools/rag.ts (branch version is OK)");
    if (fix) {
      run("git checkout HEAD -- src/agents/agent-tools/rag.ts");
      ok("Reset src/agents/agent-tools/rag.ts");
    }
  } else {
    ok("src/agents/agent-tools/rag.ts OK");
  }

  killPorts();

  if (!existsSync(path.join(root, ".env"))) {
    fail("Missing .env — cp .env.example .env and add GOOGLE_GENERATIVE_AI_API_KEY");
  }
  ok(".env present");

  console.log("\n  Running verify:jarvis…\n");
  const verify = spawnSync("pnpm", ["verify:jarvis"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (verify.status !== 0) {
    fail("verify:jarvis failed — fix errors above before dev:jarvis-local");
  }

  console.log("\n✅ jarvis:doctor — clean state. Start preview:\n");
  console.log("   pnpm dev:jarvis-local");
  console.log("   → http://localhost:3000\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
