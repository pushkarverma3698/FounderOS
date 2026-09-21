#!/usr/bin/env node
/**
 * scripts/fetch-today-jobs.ts
 * ===========================
 * Fetches today's screened jobs and pipeline status for both candidates:
 * - Pushkar Verma (`pushkar-nl-tech`)
 * - Tashi Goyal (`wife-nl-finance`)
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/fetch-today-jobs.ts [options]
 *
 * Options:
 *   --prod        Force fetch from production VPS (founderos-vps) via SSH (default if local DB has 0 today rows)
 *   --local       Force query against local DATABASE_URL
 *   --profile     Filter to specific profile ("tashi" or "pushkar")
 *   --json        Output raw JSON instead of formatted markdown
 *   --limit <N>   Max jobs to list per profile (default: 50)
 */

import { execSync } from "node:child_process";
import { getDb } from "../src/db/client.js";

interface JobRow {
  id: string;
  company: string;
  title: string;
  url: string | null;
  route: string;
  sponsor_verdict: string;
  salary_status: string;
  stage: string;
  created_at: string;
  gate_json: string | null;
}

interface ProfileStats {
  profile_id: string;
  total_lifetime: number;
  screened_today: number;
  passed_today: number;
  flagged_today: number;
  rejected_today: number;
  latest_screened_at: string | null;
  today_jobs: JobRow[];
}

const args = process.argv.slice(2);
const forceLocal = args.includes("--local");
const forceProd = args.includes("--prod");
const jsonOutput = args.includes("--json");
const profileFilter = args.find((_, i) => args[i - 1] === "--profile")?.toLowerCase();
const limitArg = args.find((_, i) => args[i - 1] === "--limit");
const limit = limitArg ? parseInt(limitArg, 10) : 50;

const PROFILES = [
  { id: "pushkar-nl-tech", name: "Pushkar Verma", alias: ["pushkar", "p"] },
  { id: "wife-nl-finance", name: "Tashi Goyal", alias: ["tashi", "wife", "t"] },
];

async function queryLocal(): Promise<ProfileStats[]> {
  const db = getDb();

  const results: ProfileStats[] = [];

  for (const p of PROFILES) {
    if (profileFilter && !p.alias.includes(profileFilter) && p.id !== profileFilter) {
      continue;
    }

    const [lifetimeRes] = (await db.execute(`
      SELECT count(*)::int as total, max(created_at) as latest
      FROM agents.job_applications
      WHERE profile_id = '${p.id}'
    `)) as unknown as Array<{ total: number; latest: string | null }>;

    const [todayCountRes] = (await db.execute(`
      SELECT
        count(*)::int as screened_today,
        count(CASE WHEN salary_status = 'pass' THEN 1 END)::int as passed_today,
        count(CASE WHEN salary_status = 'flag' THEN 1 END)::int as flagged_today,
        count(CASE WHEN salary_status = 'reject' THEN 1 END)::int as rejected_today
      FROM agents.job_applications
      WHERE profile_id = '${p.id}' AND created_at >= CURRENT_DATE
    `)) as unknown as Array<{ screened_today: number; passed_today: number; flagged_today: number; rejected_today: number }>;

    const jobs = (await db.execute(`
      SELECT id, company, title, url, route, sponsor_verdict, salary_status, stage, created_at
      FROM agents.job_applications
      WHERE profile_id = '${p.id}' AND created_at >= CURRENT_DATE
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as JobRow[];

    results.push({
      profile_id: p.id,
      total_lifetime: lifetimeRes?.total ?? 0,
      screened_today: todayCountRes?.screened_today ?? 0,
      passed_today: todayCountRes?.passed_today ?? 0,
      flagged_today: todayCountRes?.flagged_today ?? 0,
      rejected_today: todayCountRes?.rejected_today ?? 0,
      latest_screened_at: lifetimeRes?.latest ?? null,
      today_jobs: jobs ?? [],
    });
  }

  return results;
}

function queryViaProdSsh(): ProfileStats[] {
  const nodeCode = `
import { getDb } from "./src/db/client.js";
const db = getDb();
const PROFILES = [
  { id: "pushkar-nl-tech", name: "Pushkar Verma", alias: ["pushkar", "p"] },
  { id: "wife-nl-finance", name: "Tashi Goyal", alias: ["tashi", "wife", "t"] },
];
async function run() {
  const results = [];
  for (const p of PROFILES) {
    const [lifetimeRes] = await db.execute(\`
      SELECT count(*)::int as total, max(created_at) as latest
      FROM agents.job_applications
      WHERE profile_id = '\${p.id}'
    \`);
    const [todayCountRes] = await db.execute(\`
      SELECT
        count(*)::int as screened_today,
        count(CASE WHEN salary_status = 'pass' THEN 1 END)::int as passed_today,
        count(CASE WHEN salary_status = 'flag' THEN 1 END)::int as flagged_today,
        count(CASE WHEN salary_status = 'reject' THEN 1 END)::int as rejected_today
      FROM agents.job_applications
      WHERE profile_id = '\${p.id}' AND created_at >= CURRENT_DATE
    \`);
    const jobs = await db.execute(\`
      SELECT id, company, title, url, route, sponsor_verdict, salary_status, stage, created_at
      FROM agents.job_applications
      WHERE profile_id = '\${p.id}' AND created_at >= CURRENT_DATE
      ORDER BY created_at DESC
      LIMIT ${limit}
    \`);
    results.push({
      profile_id: p.id,
      total_lifetime: lifetimeRes?.total ?? 0,
      screened_today: todayCountRes?.screened_today ?? 0,
      passed_today: todayCountRes?.passed_today ?? 0,
      flagged_today: todayCountRes?.flagged_today ?? 0,
      rejected_today: todayCountRes?.rejected_today ?? 0,
      latest_screened_at: lifetimeRes?.latest ?? null,
      today_jobs: jobs ?? [],
    });
  }
  console.log("JSON_PAYLOAD_START" + JSON.stringify(results) + "JSON_PAYLOAD_END");
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
`;

  const rawOut = execSync('ssh founderos-vps "cd /opt/founderos && node --env-file=.env --import tsx/esm -"', {
    input: nodeCode,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const startTag = "JSON_PAYLOAD_START";
  const endTag = "JSON_PAYLOAD_END";
  const startIndex = rawOut.indexOf(startTag);
  const endIndex = rawOut.indexOf(endTag);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Failed to parse SSH query output from production:\n${rawOut}`);
  }

  const jsonStr = rawOut.substring(startIndex + startTag.length, endIndex);
  const parsed = JSON.parse(jsonStr) as ProfileStats[];

  if (profileFilter) {
    return parsed.filter((res) => {
      const p = PROFILES.find((prof) => prof.id === res.profile_id);
      return (p && p.alias.includes(profileFilter)) || res.profile_id === profileFilter;
    });
  }

  return parsed;
}

async function main(): Promise<void> {
  let stats: ProfileStats[] = [];

  if (forceProd) {
    stats = queryViaProdSsh();
  } else if (forceLocal) {
    stats = await queryLocal();
  } else {
    // Try local first. If 0 jobs found today, auto-fallback to prod SSH
    try {
      stats = await queryLocal();
      const totalToday = stats.reduce((acc, s) => acc + s.screened_today, 0);
      if (totalToday === 0) {
        stats = queryViaProdSsh();
      }
    } catch {
      stats = queryViaProdSsh();
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(stats, null, 2));
    process.exit(0);
  }

  console.log(`\n📅 Daily Screened Jobs Report — ${new Date().toISOString().slice(0, 10)}\n`);

  for (const s of stats) {
    const profMeta = PROFILES.find((p) => p.id === s.profile_id);
    const candidateName = profMeta?.name ?? s.profile_id;

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`👤 ${candidateName.toUpperCase()} (${s.profile_id})`);
    console.log(`   Screened Today: ${s.screened_today} | Passed: ${s.passed_today} | Flagged: ${s.flagged_today} | Rejected: ${s.rejected_today}`);
    console.log(`   Total Lifetime Rows: ${s.total_lifetime}`);
    console.log(`   Latest Sweep Hit: ${s.latest_screened_at ?? "None"}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    if (s.today_jobs.length === 0) {
      console.log(`   No new jobs screened yet today.\n`);
      continue;
    }

    s.today_jobs.forEach((j, idx) => {
      const statusIcon = j.salary_status === "pass" ? "✅ PASS" : j.salary_status === "flag" ? "⚠️ FLAG" : "❌ REJECT";
      console.log(`\n${idx + 1}. [${j.company}] ${j.title}`);
      console.log(`   Status: ${statusIcon} | Route: ${j.route} | Sponsor: ${j.sponsor_verdict}`);
      if (j.url) console.log(`   Link: ${j.url}`);
    });

    console.log("\n");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("fetch-today-jobs error:", (err as Error).message);
  process.exit(1);
});
