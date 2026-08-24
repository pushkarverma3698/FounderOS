import { getDb } from '../src/db/client.js';
import { jobApplications } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

async function run() {
  try {
    const db = getDb();
    const result = await db.select({ count: sql`count(*)` }).from(jobApplications);
    console.log("job_applications:", result[0].count);
    
    // Check if there is a companies table
    try {
      const result2 = await db.execute(sql`SELECT count(*) FROM companies;`);
      console.log("companies:", result2.rows[0].count);
    } catch(e) {
      console.log("No companies table.");
    }
    
    process.exit(0);
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}
run();
