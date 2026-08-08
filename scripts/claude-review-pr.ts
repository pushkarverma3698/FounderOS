/**
 * FounderOS — Claude Code Automated PR Review Trigger
 * ====================================================
 * Invokes Claude Code CLI in headless mode (`claude -p`) to conduct adversarial
 * review on an open PR targeting `beta`.
 *
 * Usage:
 *   pnpm pr:review <PR_NUMBER>
 *   pnpm pr:review 427
 */

import { execFileSync, spawn } from "node:child_process";
import { findClaudeBinary, buildExecutorEnv } from "../src/tools/claude-code.js";

async function main(): Promise<void> {
  const prArg = process.argv[2];
  if (!prArg) {
    console.error("❌ Usage: pnpm pr:review <PR_NUMBER>");
    process.exit(1);
  }

  const prNumber = prArg.replace("#", "").trim();
  const binary = findClaudeBinary();
  if (!binary) {
    console.error("❌ Claude Code CLI binary not found.");
    process.exit(1);
  }

  console.log(`🤖 Triggering Claude Code adversarial review on PR #${prNumber}...`);

  const reviewPrompt = `You are acting as the Adversarial Code Reviewer & Judge for FounderOS PR #${prNumber}.

Task:
1. Run \`gh pr diff ${prNumber}\` to inspect the changes.
2. Checkout the PR branch using \`gh pr checkout ${prNumber}\`.
3. Run \`pnpm gate\` to verify typechecks, builds, ratchets, and unit tests.
4. Perform adversarial review: look for race conditions, false-success claims, unhandled side-effects, or unverified assumptions.
5. If the implementation is sound and verified, approve the PR:
   \`gh pr review ${prNumber} --approve -b "Adversarial review passed for PR #${prNumber}."\`
6. If defects or edge-case failures are found, either push the smallest correct fix directly to the branch or post a detailed comment using \`gh pr review ${prNumber} --comment -b "..."\`.
7. Keep output concise.
`;

  const cleanEnv = buildExecutorEnv();
  delete cleanEnv.GH_TOKEN;
  delete cleanEnv.GITHUB_TOKEN;

  const child = spawn(binary, ["-p", reviewPrompt, "--permission-mode", "acceptEdits"], {
    cwd: process.cwd(),
    env: cleanEnv,
    stdio: "inherit",
  });

  child.on("close", (code) => {
    if (code === 0) {
      console.log(`✅ Claude Code review process for PR #${prNumber} completed.`);
    } else {
      console.error(`❌ Claude Code review process exited with code ${code}.`);
    }
  });
}

main().catch((err) => {
  console.error("❌ Failed to launch PR review:", err);
  process.exit(1);
});
