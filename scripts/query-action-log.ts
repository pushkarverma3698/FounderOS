import { db } from "../src/db/client.js";
import { sql } from "drizzle-orm";

async function main() {
  const logs = await db.execute(sql`
    SELECT turn_id, worker, step, kind, payload
    FROM _action_log
    ORDER BY created_at DESC
    LIMIT 50
  `);
  console.log(JSON.stringify((logs as any).rows ?? logs, null, 2));
}

main().catch(console.error).finally(() => process.exit(0));
