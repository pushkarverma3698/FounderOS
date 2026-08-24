import { Pool } from 'pg';

const pool = new Pool({ connectionString: 'postgres://postgres:postgres@localhost:5432/postgres' });

async function run() {
  try {
    const jobs = await pool.query('SELECT count(*) FROM job_applications;');
    console.log("job_applications:", jobs.rows[0].count);
    
    try {
      const companies = await pool.query('SELECT count(*) FROM companies;');
      console.log("companies:", companies.rows[0].count);
    } catch (e) {
      console.log("No companies table found or error:", e.message);
    }
    
    // Check if there are other tables that represent jobs
    try {
      const jobsTable = await pool.query('SELECT count(*) FROM jobs;');
      console.log("jobs:", jobsTable.rows[0].count);
    } catch (e) {
      console.log("No jobs table found");
    }
  } catch (e) {
    console.error("DB Error:", e.message);
  } finally {
    pool.end();
  }
}

run();
