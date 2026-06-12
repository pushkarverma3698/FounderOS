/**
 * Live verification against the REAL Postgres-persisted thread, replicating the
 * EXACT gateway sequence from runOfficeText:
 *   1. resolvePendingApproval  (reject a parked HITL interrupt, if any)
 *   2. recoverWedgedThread     (clear an aborted-run wedge, if any)
 *   3. fresh invoke            (the new message starts clean)
 *
 * Run: node --env-file=.env --import tsx/esm scripts/verify-wedge-fix-live.ts <chatId> ["message"]
 */
import { HumanMessage } from "@langchain/core/messages";
import { getOffice } from "../src/agents/office.js";
import { resolvePendingApproval, recoverWedgedThread } from "../src/gateway/telegram.js";
import { isWedgedState, pendingInterruptCount, type WedgeState } from "../src/infra/wedge.js";
import { TENANT } from "../src/core/config.js";

async function main() {
  const chatId = process.argv[2] ?? "6775330211";
  const message = process.argv[3] ?? "There?";
  const threadId = `${TENANT}:${chatId}`;
  const office = await getOffice();
  const config = { configurable: { thread_id: threadId }, recursionLimit: 12 };

  const before = (await office.getState(config)) as WedgeState;
  console.log(`\nBEFORE: next=${JSON.stringify(before.next ?? [])} interrupts=${pendingInterruptCount(before)} wedged=${isWedgedState(before)}`);

  // Step 1 — gateway: reject any parked HITL interrupt so the new message runs clean.
  const stale = await resolvePendingApproval(office, config);
  if (stale) console.log(`STEP 1 resolvePendingApproval: rejected stale approval "${stale.title}"`);
  else console.log("STEP 1 resolvePendingApproval: none pending");

  // Step 2 — gateway: clear an aborted-run wedge.
  const recovered = await recoverWedgedThread(office, config, threadId);
  console.log(`STEP 2 recoverWedgedThread: ${recovered ? "WEDGE CLEARED" : "no wedge"}`);

  const mid = (await office.getState(config)) as WedgeState;
  console.log(`AFTER GUARDS: next=${JSON.stringify(mid.next ?? [])} interrupts=${pendingInterruptCount(mid)}`);

  // Step 3 — fresh invoke of the new message.
  console.log(`\nSTEP 3 invoke "${message}" ...`);
  const res = (await office.invoke({ messages: [new HumanMessage(message)] }, config)) as {
    messages?: Array<{ content?: unknown; _getType?: () => string }>;
  };
  const last = (res.messages ?? []).filter((m) => m._getType?.() === "ai").pop();
  const reply = typeof last?.content === "string" ? last.content : "";
  console.log(`REPLY: ${reply.slice(0, 200)}`);
  console.log(`\n${reply.trim() ? "✅ PASS — thread answered without looping" : "❌ FAIL — empty/looped"}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
