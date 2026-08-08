/**
 * FounderOS — Claude Code Automated PR Review Engine
 * ====================================================
 * Invokes Claude Code CLI in headless mode (`claude -p`) to conduct adversarial
 * review & self-fixing on open PRs targeting `beta`.
 *
 * Usage:
 *   pnpm pr:review 427
 *   pnpm pr:review 428
 *   pnpm pr:review all
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { findClaudeBinary, buildExecutorEnv } from "../src/tools/claude-code.js";

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = buildExecutorEnv();
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

async function reviewPR(prNumber: string, binary: string, instructions: string): Promise<void> {
  console.log(`\n================================================================================`);
  console.log(`🤖 Triggering Claude Code Adversarial Review & Self-Fixing on PR #${prNumber}...`);
  console.log(`================================================================================\n`);

  const reviewPrompt = `You are acting as the Senior Adversarial Code Reviewer & Judge for FounderOS PR #${prNumber}.

Follow the binding instructions in CLAUDE_REVIEWER_INSTRUCTIONS:

${instructions}

Execution Brief for PR #${prNumber}:
1. Inspect diffs: \`gh pr diff ${prNumber}\`
2. Checkout PR branch: \`gh pr checkout ${prNumber}\`
3. Run mandatory gates: \`pnpm gate\`
4. Perform adversarial review (check false successes, unescaped strings, wiring ratchets).
5. If defects found: write smallest fix, run \`pnpm gate\`, commit & push directly.
6. If 100% green: issue approval (\`gh pr review ${prNumber} --approve -b "Empirically verified."\`) and mark ready (\`gh pr ready ${prNumber}\`).
7. Keep output concise.
`;

  await new Promise<void>((resolve) => {
    const child = spawn(binary, ["-p", reviewPrompt, "--permission-mode", "acceptEdits"], {
      cwd: process.cwd(),
      env: getCleanEnv(),
      stdio: "inherit",
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`\n✅ Claude Code review process for PR #${prNumber} completed.`);
      } else {
        console.error(`\n❌ Claude Code review process for PR #${prNumber} exited with code ${code}.`);
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const prArg = process.argv[2];
  if (!prArg) {
    console.error("❌ Usage: pnpm pr:review <PR_NUMBER|all>");
    process.exit(1);
  }

  const binary = findClaudeBinary();
  if (!binary) {
    console.error("❌ Claude Code CLI binary not found.");
    process.exit(1);
  }

  const protocolPath = join(process.cwd(), "docs/antigravity/CLAUDE_REVIEWER_INSTRUCTIONS.md");
  const instructions = existsSync(protocolPath)
    ? readFileSync(protocolPath, "utf8")
    : "Run pnpm gate, test edge cases, fix defects directly, and approve green PRs.";

  if (prArg.toLowerCase() === "all") {
    console.log("🔍 Fetching all open PRs targeting 'beta'...");
    const raw = execFileSync("gh", ["pr", "list", "--base", "beta", "--json", "number"], {
      encoding: "utf8",
      env: getCleanEnv(),
    });
    const prs = JSON.parse(raw) as Array<{ number: number }>;
    if (prs.length === 0) {
      console.log("ℹ️ No open PRs targeting 'beta' found.");
      return;
    }

    console.log(`📋 Found ${prs.length} open PR(s) targeting 'beta': ${prs.map((p) => `#${p.number}`).join(", ")}`);
    for (const pr of prs) {
      await reviewPR(String(pr.number), binary, instructions);
    }
  } else {
    const prNumber = prArg.replace("#", "").trim();
    await reviewPR(prNumber, binary, instructions);
  }
}

main().catch((err) => {
  console.error("❌ Failed to launch PR review engine:", err);
  process.exit(1);
});
