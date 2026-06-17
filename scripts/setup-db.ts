/**
 * FounderOS — Database Setup Script
 * ===================================
 * Run once to initialize the database:
 *  1. Apply drizzle migrations (creates app tables)
 *  2. Run LangGraph checkpointer.setup() (creates checkpoint tables)
 *
 * Usage:
 *   npx tsx scripts/setup-db.ts
 *
 * Safe to run multiple times — idempotent.
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb, getPgPool, closeDatabaseConnections } from "../src/db/client.js";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

async function main(): Promise<void> {
  console.log("🔧 FounderOS DB Setup\n");

  // 1. Drizzle migrations
  console.log("1️⃣  Running Drizzle migrations…");
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("   ✅ App tables ready\n");

  // 2. LangGraph checkpointer tables
  console.log("2️⃣  Setting up LangGraph checkpoint tables…");
  const pool = getPgPool();
  const checkpointer = PostgresSaver.fromConnString(process.env["DATABASE_URL"]!, {
    schema: "agents",
  });
  await checkpointer.setup();
  console.log("   ✅ Checkpoint tables ready\n");

  void pool; // pool referenced above, kept alive until close

  console.log("🎉 Database setup complete!\n");
  console.log("Next: npx tsx src/index.ts");
}

main()
  .catch((err) => {
    console.error("❌ Setup failed:", err);
    process.exit(1);
  })
  .finally(() => closeDatabaseConnections());
