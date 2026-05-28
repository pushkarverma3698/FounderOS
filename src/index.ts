/**
 * FounderOS — Entry Point
 * ========================
 * Startup sequence:
 *  1. Init telemetry (LangSmith)
 *  2. Compile LangGraph (initialises DB checkpointer internally)
 *  3. Wire HITL dependency injection (sendFn + resumeFn)
 *  4. Start Telegram bot (long polling)
 *  5. Register SIGTERM/SIGINT handlers for graceful shutdown
 */

import { Command } from "@langchain/langgraph";
import { initTelemetry } from "./infra/telemetry.js";
import { closeDatabaseConnections } from "./db/client.js";
import { getGraph } from "./agents/graph.js";
import { initHITL } from "./gateway/hitl.js";
import { sendHITLMessage, startBot, stopBot } from "./gateway/telegram.js";
import { initScheduler, stopScheduler } from "./infra/scheduler.js";
import { closeRedis } from "./infra/redis.js";
import { logger } from "./infra/logger.js";

const log = logger.child({ module: "main" });

async function main(): Promise<void> {
  log.info("FounderOS starting…");

  // 1. Telemetry — must be first (PII scrubbing hooks in before any LLM call)
  initTelemetry();

  // 2. Compile graph (initialises DB checkpointer internally)
  const graph = await getGraph();
  log.info("Graph ready");

  // 3. Wire HITL dependency injection
  //    sendFn   — sends approval message to Telegram, returns message_id
  //    resumeFn — resumes a suspended LangGraph thread with the human's decision
  initHITL(
    // sendFn
    (topicId, interruptId, summary, draft, agent) =>
      sendHITLMessage(topicId, interruptId, summary, draft, agent),

    // resumeFn
    async (threadId, decision) => {
      const g = await getGraph();
      await g!.invoke(
        new Command({ resume: decision }),
        { configurable: { thread_id: threadId } },
      );
    },
  );
  log.info("HITL wired");

  // 4. Start background scheduler (LinkedIn poster, reply poller, HITL sweeper)
  initScheduler();
  log.info("Scheduler ready");

  // 5. Start Telegram bot (long polling — runs in background)
  await startBot();

  log.info("FounderOS running 🚀");
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "Shutdown signal received — draining…");
  stopScheduler();
  await stopBot();
  await closeDatabaseConnections();
  await closeRedis();
  log.info("FounderOS stopped cleanly");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM").catch(console.error));
process.on("SIGINT",  () => shutdown("SIGINT").catch(console.error));
process.on("uncaughtException", (err) => {
  log.fatal({ err: err.message, stack: err.stack }, "Uncaught exception — shutting down");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.fatal({ reason: String(reason) }, "Unhandled rejection — shutting down");
  process.exit(1);
});

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
