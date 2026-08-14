/**
 * FounderOS — Self-Improvement Acting Loop (manual entry point)
 * =============================================================
 * `pnpm self-improve:run` — the same loop the scheduler fires every third day
 * at 09:00 (src/infra/scheduler.ts), runnable by hand.
 *
 * ## What changed on 2026-08-13, and why
 *
 * This script used to invoke the Claude Code CLI with `--permission-mode
 * acceptEdits` against `process.cwd()` and let it edit the repository directly.
 * That could not work on either host — `resolveExecutorCwd`
 * (src/tools/claude-code.ts) refuses the FounderOS repo on the laptop and
 * refuses `/opt/founderos` on prod for being outside `~/Projects` — so the
 * "loop that acts" had only ever been capable of printing an error. Verified by
 * running the guard on both.
 *
 * It now files ONE GitHub issue for the top actionable finding and lets the
 * existing unattended pipeline do the work: `agent-dispatch` (VPS, every 15 min)
 * claims it and Antigravity implements it in an isolated workspace, `pr-brain`
 * (every 20 min) reviews the resulting draft PR. The founder acts only at the
 * merge. See src/evolution/dispatch-findings.ts for the full rationale.
 *
 * The orchestration lives in `src/` so it can be unit-tested and so the
 * scheduler can call it without importing from `scripts/` — the import
 * direction that made the audit cron and the audit CLI drift into two different
 * renderers (src/evolution/audit-sweep.ts).
 */

import { runSelfImprovementDispatch } from "../src/evolution/dispatch-findings.js";
import { renderDispatchMessage } from "../src/evolution/dispatch-message.js";
import { sendToChat } from "../src/infra/telegram-send.js";
import { syncConversationSessions } from "./sync-conversation-session.js";

export async function runSelfImprovementLoop(): Promise<void> {
  console.log("=== FounderOS Self-Improvement Acting Loop ===");

  // Laptop-only, and deliberately not part of the scheduled path: this reads
  // Claude Code transcripts from ~/.claude/projects, which exist on this machine
  // and not on the VPS. Kept here so `pnpm self-improve:run` still syncs them.
  try {
    const sessionRes = await syncConversationSessions();
    console.log(`Synced ${sessionRes.synced} conversation sessions into DB memory.`);
  } catch (err) {
    console.warn("Session sync failed (continuing):", (err as Error).message);
  }

  const outcome = await runSelfImprovementDispatch();

  console.log(`\nOutcome: ${outcome.state}`);
  if (outcome.state === "filed") {
    console.log(`Filed #${outcome.issueNumber}: ${outcome.url}`);
    console.log(`  ${outcome.finding.kind} · ${outcome.finding.severity} · ${outcome.finding.subject}`);
  }

  await sendToChat(renderDispatchMessage(outcome), "HTML");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSelfImprovementLoop().catch((e) => {
    console.error("Self-improvement loop failed:", e);
    process.exit(1);
  });
}
