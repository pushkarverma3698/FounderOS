/**
 * FounderOS — Self-Improving Autonomous Runner Script
 * ===================================================
 * Reads saved data (turicks_brain transcripts, failure_lessons, self-audit findings),
 * constructs a targeted engineering prompt prioritized by Founder Friction Saved &
 * Execution Outcome Quality, and invokes Claude Code CLI (claude -p) automatically.
 *
 * Runs on schedule (every 3 days) or on demand.
 * Usage: pnpm self-improve:run
 */

import { resolve } from "node:path";
import { claudeCodeTool } from "../src/tools/claude-code.js";
import { collectSourceFiles } from "../src/evolution/collect.js";
import {
  findDeadExports,
  findOrphanModules,
} from "../src/evolution/analyzers/dead-code.js";
import {
  findOversizedPrompts,
  findUntestedModules,
} from "../src/evolution/analyzers/code-health.js";
import { rankFindings } from "../src/evolution/rank.js";
import { sendToChat } from "../src/infra/telegram-send.js";
import { syncConversationSessions } from "./sync-conversation-session.js";

const ROOT = resolve(process.cwd());

export async function runSelfImprovementLoop(): Promise<void> {
  console.log("=== FounderOS Autonomous Self-Improvement Loop ===");

  // 1. Sync conversation session transcripts to DB memory
  try {
    const sessionRes = await syncConversationSessions();
    console.log(`Synced ${sessionRes.synced} conversation sessions into DB memory.`);
  } catch (err) {
    console.warn("Session sync failed (continuing):", (err as Error).message);
  }

  // 2. Gather static audit findings
  const files = collectSourceFiles(ROOT, "src");
  const testFiles = collectSourceFiles(ROOT, "tests");
  const staticFindings = [
    ...findDeadExports(files),
    ...findOrphanModules(files),
    ...findOversizedPrompts(files),
    ...findUntestedModules(files, testFiles),
  ];
  const ranked = rankFindings(staticFindings);
  const topFindings = ranked.slice(0, 3);

  if (topFindings.length === 0) {
    console.log("No high-priority codebase findings. System is healthy!");
    await sendToChat("✅ <b>Autonomous Self-Improvement Audit</b>: 0 code issues detected. System healthy!", "HTML");
    return;
  }

  // 3. Construct Claude Code prompt
  const findingSummaries = topFindings
    .map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.kind} on ${f.subject}: ${f.evidence}`)
    .join("\n");

  const prompt = [
    `You are the autonomous FounderOS engineering agent. Address these high-priority codebase findings to maximize Founder Friction Saved and Execution Outcome Quality:`,
    ``,
    findingSummaries,
    ``,
    `Rules:`,
    `1. Maintain strict type safety (tsc --noEmit clean).`,
    `2. Keep files under 400 LOC budget limit.`,
    `3. Reason before code and minimize blast radius.`,
    `4. Verify with pnpm gate before finishing.`,
  ].join("\n");

  console.log("\nConstructed Claude Code Directive:");
  console.log(prompt);

  await sendToChat(
    `🛠 <b>Autonomous Self-Improvement Initiated</b>\n\nInvoking Claude Code on ${topFindings.length} findings:\n${findingSummaries}`,
    "HTML"
  );

  // 4. Run Claude Code CLI headless
  const result = await claudeCodeTool.execute({
    task: prompt,
    cwd: ROOT,
  });

  if (result.success) {
    console.log("Claude Code execution succeeded!");
    await sendToChat(
      `✅ <b>Autonomous Self-Improvement Succeeded</b>\n\n${String(result.data).slice(0, 500)}`,
      "HTML"
    );
  } else {
    console.error("Claude Code execution failed:", result.error);
    await sendToChat(
      `⚠️ <b>Autonomous Self-Improvement Encountered Error</b>: ${result.error?.slice(0, 300)}`,
      "HTML"
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSelfImprovementLoop().catch((e) => {
    console.error("Self-improvement loop failed:", e);
    process.exit(1);
  });
}
