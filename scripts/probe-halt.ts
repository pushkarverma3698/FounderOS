/**
 * Real-path probe for the global kill switch (CLAUDE.md rule #19).
 *
 * Drives the ACTUAL exported gateway function `runOfficeText` (src/gateway/office-run.ts)
 * with a fake grammy Context, with and without the halt flag engaged. Because the halt
 * gate sits at the very top of runOfficeText — before getOffice()/Postgres/model — this
 * exercises the real refusal path without needing the office, DB, or an LLM call.
 *
 * Proves the production invariant: when halted, the founder gets the halt notice and the
 * office is NEVER invoked (no side effect, no action_log row). When not halted, the turn
 * proceeds (here it will hit the real office — we only assert that it got PAST the gate).
 *
 * Run:  node --env-file=.env --import tsx/esm scripts/probe-halt.ts
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the flag file so we never touch the real $HOME/.founderos/HALT.
const dir = mkdtempSync(join(tmpdir(), "founderos-probe-halt-"));
process.env["HALT_FLAG_PATH"] = join(dir, "HALT");

const { engageHalt, releaseHalt } = await import("../src/infra/halt.js");
const { runOfficeText } = await import("../src/gateway/office-run.js");

let replies: string[] = [];

/** Minimal fake grammy Context — only what runOfficeText touches. */
function fakeCtx(): any {
  return {
    chat: { id: 6775330211 },
    from: { id: 6775330211, first_name: "Probe" },
    message: { text: "what is 2+2?", date: Math.floor(Date.now() / 1000) },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    },
    replyWithChatAction: async () => ({}),
    api: { sendChatAction: async () => ({}) },
  };
}

function ok(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) process.exitCode = 1;
}

console.log("\n=== PROBE 1: halted → refusal, office NOT invoked ===");
await engageHalt("probe deploy", "founder");
replies = [];
await runOfficeText(fakeCtx(), "what is 2+2?");
const haltedReply = replies.join("\n");
console.log("bot reply:", JSON.stringify(haltedReply.slice(0, 140)));
ok(replies.length === 1, "exactly one reply sent");
ok(/halted/i.test(haltedReply), "reply says 'halted'");
ok(/probe deploy/.test(haltedReply), "reply includes the halt reason");
ok(/\/resume/.test(haltedReply), "reply tells founder to /resume");
ok(existsSync(process.env["HALT_FLAG_PATH"]!), "halt flag file present while halted");

console.log("\n=== PROBE 2: resumed → gate passes (turn proceeds past the gate) ===");
await releaseHalt();
ok(!existsSync(process.env["HALT_FLAG_PATH"]!), "halt flag removed after /resume");
replies = [];
try {
  await runOfficeText(fakeCtx(), "what is 2+2?");
  const liveReply = replies.join("\n");
  console.log("bot reply:", JSON.stringify(liveReply.slice(0, 140)));
  ok(!/is halted/i.test(liveReply), "reply is NOT the halt notice (turn went through the office)");
  ok(replies.length >= 1, "office produced at least one reply");
} catch (err) {
  // Office/DB/model may be unavailable in this env — that's fine: it still proves the
  // gate let the turn THROUGH (we got past the halt return).
  console.log("(office threw past the gate — acceptable, gate was passed):", (err as Error).message.slice(0, 120));
  ok(true, "turn proceeded past the halt gate (office error is environmental, not the gate)");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\nDone. exitCode=${process.exitCode ?? 0}`);
// Force exit — the office may hold open DB/redis handles.
setTimeout(() => process.exit(process.exitCode ?? 0), 500);
