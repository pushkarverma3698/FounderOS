---
name: daily-jobs-fetcher
description: Autonomous fetcher and inspector for Pushkar and Tashi's daily screened jobs, pipeline health, and application status from FounderOS production database and jobhunt tools. Use whenever the user asks for today's jobs, daily screened jobs, candidate job updates, or latest jobhunt status.
---

# Daily Jobs Fetcher Skill

This skill provides an autonomous, reproducible workflow for inspecting, querying, and reporting today's screened jobs and pipeline health for both registered FounderOS candidates:
1. **Pushkar Verma** (`pushkar-nl-tech`) — AI Engineer, Senior Full-Stack, Backend, Distributed Systems.
2. **Tashi Goyal** (`wife-nl-finance`) — FP&A Analyst, Financial Analyst, KYC/Compliance, Audit, Revenue Accountant.

---

## When to Trigger This Skill

Activate this skill whenever the user says or asks:
- "Check for today's screened jobs"
- "What jobs did we get today?"
- "Fetch jobs for Tashi and Pushkar"
- "Daily jobs update / report"
- "Any new jobs screened today?"
- "What's in the job queue for Pushkar/Tashi today?"

---

## Architecture & Data Location

1. **Live Production Store:**
   - Production PostgreSQL runs on the VPS (`founderos-vps`) under database `founderos`.
   - Table: `agents.job_applications` (stores deduplicated screened postings, verdicts, routes, salary checks, gate statuses, and apply queue state).
   - Ingest Run Ledger: `agents.job_ingest_runs` (records every 30-minute sweep run and funnel counts).
   - Heartbeat: `agents.job_lane_heartbeats` (records last active sweep and alert message timestamps).

2. **Isolated Candidate Profiles:**
   - `pushkar-nl-tech`: Filtered by routes (`india-local`, `zoekjaar`, `partner-permit`, `hsm`, `remote-contract`).
   - `wife-nl-finance`: Filtered by routes (`india-local`, `zoekjaar`, `remote-contract`), FP&A and finance vocabulary.

---

## Execution Runbook

### Option 1: Fast Automated Runner (Recommended)

Run the dedicated fetcher script from the repo root:

```bash
# Fetch today's screened jobs for both candidates:
node --env-file=.env --import tsx/esm scripts/fetch-today-jobs.ts

# Filter to Tashi only:
node --env-file=.env --import tsx/esm scripts/fetch-today-jobs.ts --profile tashi

# Filter to Pushkar only:
node --env-file=.env --import tsx/esm scripts/fetch-today-jobs.ts --profile pushkar

# Output structured JSON:
node --env-file=.env --import tsx/esm scripts/fetch-today-jobs.ts --json

# Limit job count output:
node --env-file=.env --import tsx/esm scripts/fetch-today-jobs.ts --limit 20
```

> **Note on connectivity:** The script automatically probes local Postgres first; if 0 rows are found for today, it automatically queries the live production database on `founderos-vps` via SSH, ensuring fresh data is always returned.

---

### Option 2: Deterministic In-App Tool Execution

You can also run FounderOS's native tools directly against production:

```bash
# Check job_state for both candidates
ssh founderos-vps "cd /opt/founderos && node --env-file=.env --import tsx/esm -e '
import { jobStateTool } from \"./src/tools/job-state.js\";
async function run() {
  const tashi = await jobStateTool.execute({ profile: \"tashi\", since: new Date(new Date().setHours(0,0,0,0)).toISOString() });
  const pushkar = await jobStateTool.execute({ profile: \"pushkar-nl-tech\", since: new Date(new Date().setHours(0,0,0,0)).toISOString() });
  console.log(\"Tashi:\", JSON.parse(tashi.data));
  console.log(\"Pushkar:\", JSON.parse(pushkar.data));
  process.exit(0);
}
run();
'"
```

---

## Output Format & Report Structure

Always present the findings to the user following this clear, empirical format:

1. **Executive Metrics Table (Today):**
   - Candidate
   - Screened Today
   - Passed
   - Flagged
   - Rejected
   - Latest Sweep Timestamp

2. **Candidate Breakdowns:**
   - **Tashi Goyal (`wife-nl-finance`)**:
     - List all roles screened today with Company, Title, Route, Status (`PASS`, `FLAG`, `REJECT`), and Direct Application Link.
   - **Pushkar Verma (`pushkar-nl-tech`)**:
     - Route distribution (e.g. `india-local`, `partner-permit`, etc.).
     - List of top passing and actionable roles with Company, Title, Route, Status, and Direct Application Link.

3. **Telegram Status / Next Actions:**
   - Note if any roles were alerted to Telegram or if they require manual review via `/jobs` or `/wife_jobs`.
