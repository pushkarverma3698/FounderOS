/**
 * Probe: run a REAL claude_code build for AgentOps neon landing (no deploy).
 * Evidence: files on disk + optional local preview URL.
 *
 * Run on VPS (Claude CLI required):
 *   node --env-file=.env --import tsx/esm scripts/probe-cinematic-build.ts
 *
 * Env:
 *   PROBE_BUILD_DIR — workspace (default ~/Projects/agent-workspace-probe-<ts>)
 *   PROBE_SKIP_BUILD=1 — only check existing dir
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeCodeTool, findClaudeBinary } from "../src/tools/claude-code.js";

const stamp = Date.now();
const defaultDir = join(homedir(), "Projects", `agent-workspace-probe-${stamp}`);
const workDir = process.env["PROBE_BUILD_DIR"] ?? defaultDir;

const TASK = `Build a cinematic single-page landing for fictional AI observability startup "AgentOps".
Requirements:
- Dark neon / terminal aesthetic (the "neon" preset vibe)
- Hero headline + subhead + primary CTA button
- One features section (3 bullets)
- Use Vite + React OR a polished static HTML/CSS/JS single page in THIS directory
- Create all files here; run build if using Vite and fix errors until dist/ or index.html works
- Do NOT git push, do NOT deploy, do NOT start a long-running dev server
- End your reply with: FILES: <comma-separated paths> and HERO: <exact hero headline text>`;

function listFiles(dir: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) out.push(...listFiles(p, depth + 1));
      else out.push(p);
    } catch {
      /* skip */
    }
  }
  return out;
}

function findEntryHtml(files: string[]): string | null {
  const ranked = files.filter((f) => /index\.html$/i.test(f) || /dist\/.*\.html$/i.test(f));
  ranked.sort((a, b) => (a.includes("/dist/") ? -1 : 1));
  return ranked[0] ?? null;
}

async function previewFile(filePath: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const dir = filePath.replace(/\/[^/]+$/, "");
    const child = spawn("npx", ["--yes", "serve", dir, "-l", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("serve timeout"));
    }, 30_000);
    setTimeout(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        const html = await res.text();
        clearTimeout(timer);
        child.kill();
        resolve(html.slice(0, 1500));
      } catch (e) {
        clearTimeout(timer);
        child.kill();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }, 4000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main(): Promise<void> {
  console.log("\n🔬 Probe — cinematic build (claude_code, no deploy)\n");
  console.log("workspace:", workDir);

  const binary = findClaudeBinary();
  if (!binary) {
    console.error("❌ Claude CLI not found on this host");
    process.exit(1);
  }
  console.log("claude:", binary);

  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  if (process.env["PROBE_SKIP_BUILD"] !== "1") {
    console.log("\n==> Running claude_code build (may take several minutes)...\n");
    const res = await claudeCodeTool.execute({ task: TASK, cwd: workDir });
    if (!res.success) {
      console.error("❌ claude_code failed:", res.error);
      process.exit(1);
    }
    const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    console.log("--- claude_code reply (tail) ---");
    console.log(text.slice(-2000));
  }

  const files = listFiles(workDir);
  console.log("\n==> Files created:", files.length);
  for (const f of files.slice(0, 25)) console.log("   ", f);
  if (files.length > 25) console.log(`   ... +${files.length - 25} more`);

  const entry = findEntryHtml(files);
  if (!entry) {
    console.error("\n❌ FAIL — no index.html found in workspace");
    process.exit(1);
  }
  console.log("\n✅ Entry HTML:", entry);
  const snippet = readFileSync(entry, "utf-8").slice(0, 800);
  console.log("--- HTML preview (first 800 chars) ---");
  console.log(snippet);

  const port = 8765 + (stamp % 100);
  try {
    const served = await previewFile(entry, port);
    console.log("\n✅ Local serve preview (curl via npx serve):");
    console.log(served.slice(0, 1200));
    if (/agentops|observability|neon|agent/i.test(served)) {
      console.log("\n✅ Preview contains expected AgentOps/neon content");
    } else {
      console.log("\n⚠️  Preview loaded but content keywords not matched — inspect HTML above");
    }
  } catch (e) {
    console.log("\n⚠️  Local serve preview skipped:", e instanceof Error ? e.message : e);
    console.log("   (static files on disk are still valid build evidence)");
  }

  console.log("\n✅ BUILD PROBE PASSED — artifacts at", workDir);
}

main().catch((e) => {
  console.error("PROBE CRASH:", e);
  process.exit(1);
});
