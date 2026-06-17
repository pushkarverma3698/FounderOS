/** Postgres connectivity ping for daily regression (no shell backticks). */
import postgres from "postgres";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("FAIL: DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1, connect_timeout: 10 });
try {
  await sql.unsafe("SELECT 1");
  console.log("PASS postgres_ping");
} catch (err) {
  console.error("FAIL postgres_ping:", err);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
