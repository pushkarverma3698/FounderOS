/**
 * FounderOS — Thread Inspector
 * ==============================
 * Debug tool: print all checkpoints for a given thread_id.
 *
 * Usage:
 *   npx tsx scripts/inspect-thread.ts <thread_id>
 *   npx tsx scripts/inspect-thread.ts turicks:telegram:123456789:run-abc123
 */

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { closeDatabaseConnections } from "../src/db/client.js";

async function main(): Promise<void> {
  const threadId = process.argv[2];
  if (!threadId) {
    console.error("Usage: npx tsx scripts/inspect-thread.ts <thread_id>");
    process.exit(1);
  }

  console.log(`\n🔍 Inspecting thread: ${threadId}\n`);

  const checkpointer = PostgresSaver.fromConnString(process.env["DATABASE_URL"]!);
  await checkpointer.setup();

  const config = { configurable: { thread_id: threadId } };
  let checkpointCount = 0;

  for await (const checkpoint of checkpointer.list(config)) {
    checkpointCount++;
    const { checkpoint: cp, metadata } = checkpoint;
    console.log(`--- Checkpoint ${checkpointCount} ---`);
    console.log("ID:", cp.id);
    console.log("Timestamp:", cp.ts);
    console.log("Step:", metadata?.step);
    console.log("Source:", metadata?.source);
    if (Object.keys(cp.channel_values ?? {}).length > 0) {
      console.log("State keys:", Object.keys(cp.channel_values ?? {}));
      // Print non-message fields (messages can be huge)
      const { messages: _msgs, ...rest } = cp.channel_values as Record<string, unknown>;
      void _msgs;
      console.log("State (no messages):", JSON.stringify(rest, null, 2));
    }
    console.log();
  }

  if (checkpointCount === 0) {
    console.log("No checkpoints found for this thread.");
  } else {
    console.log(`Total checkpoints: ${checkpointCount}`);
  }
}

main()
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  })
  .finally(() => closeDatabaseConnections());
