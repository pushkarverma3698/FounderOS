import { db } from "../src/db/client.js";
import { sql } from "drizzle-orm";
const rows = await db.execute(sql`SELECT id, action, idempotency_key, created_at FROM action_log ORDER BY created_at DESC LIMIT 5`);
console.log(JSON.stringify(rows, null, 2).slice(0, 1500));
process.exit(0);
