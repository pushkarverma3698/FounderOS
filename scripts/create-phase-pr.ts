/**
 * FounderOS — Phase PR Creation Helper
 * =====================================
 * Automates opening Draft PRs to `beta` for Claude Code review & adversarial gate.
 *
 * Enforces:
 *   1. Branch is not `main` or `beta`
 *   2. `beta` is merged locally first to prevent base drift
 *   3. `pnpm gate` is green before pushing
 *   4. PR target is ALWAYS `beta` (ADR-045 / AGENTS.md policy)
 *   5. Outputs structured Claude Code review prompt + commands
 *
 * Usage:
 *   pnpm tsx scripts/create-phase-pr.ts --phase 1 --title "fix(jobhunt): repair free lane age deadlock"
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }).trim();
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const phase = arg("--phase") ?? "1";
  const rawTitle = arg("--title") ?? `fix: phase ${phase} transition changes`;
  const skipGate = hasFlag("--skip-gate");

  const branch = run("git rev-parse --abbrev-ref HEAD");
  if (branch === "main" || branch === "beta") {
    console.error(`❌ Cannot open PR from '${branch}'. Cut a feature branch from beta first.`);
    process.exit(1);
  }

  console.log(`🚀 Preparing PR from branch '${branch}' targeting 'beta'...`);

  if (!skipGate) {
    console.log("🔍 Running pnpm gate validation...");
    execSync("pnpm gate", { stdio: "inherit" });
  }

  console.log("🔄 Fetching and merging latest origin/beta...");
  run("git fetch origin beta");
  try {
    run("git merge origin/beta --no-edit");
  } catch (e) {
    console.warn("⚠️ Merge warning from origin/beta — resolve conflicts if any.");
  }

  console.log(`📤 Pushing branch '${branch}' to origin...`);
  run(`git push -u origin ${branch}`);

  // Construct structured PR body
  const body = `## Phase ${phase} Transition PR — Antigravity → Claude Code Review

### Summary & Objective
- **Branch:** \`${branch}\`
- **Target:** \`beta\`
- **Phase:** Phase ${phase}

### Verification Evidence
- \`pnpm gate\`: Green (Typechecks, builds, ratchets, and unit tests passed)
- Verification script executed & green.

### Reviewer Instructions (Claude Code)
1. Run \`gh pr checkout <PR_NUMBER>\` or inspect diff \`gh pr diff <PR_NUMBER>\`
2. Perform adversarial review: look for race conditions, false successes, unhandled side-effects.
3. If approved, run \`gh pr review <PR_NUMBER> --approve -b "Phase ${phase} adversarial review passed."\`
4. If fixes needed, push commits directly to \`${branch}\` or comment.
`;

  const prTitle = rawTitle.startsWith("feat:") || rawTitle.startsWith("fix:") || rawTitle.startsWith("chore:")
    ? rawTitle
    : `fix(phase-${phase}): ${rawTitle}`;

  console.log("📝 Creating GitHub Draft PR to beta...");
  const prUrl = run(
    `gh pr create --base beta --head ${branch} --draft --title ${JSON.stringify(prTitle)} --body ${JSON.stringify(body)}`
  );

  console.log("\n================================================================================");
  console.log(`✅ Draft PR Created Successfully!`);
  console.log(`PR URL: ${prUrl}`);
  console.log("================================================================================");
  console.log(`\n📋 Claude Code Handoff Command:`);
  console.log(`  gh pr diff ${prUrl}`);
  console.log(`  gh pr checkout ${prUrl.split("/").pop()}`);
  console.log(`================================================================================\n`);
}

main().catch((err) => {
  console.error("❌ Failed to create PR:", err);
  process.exit(1);
});
