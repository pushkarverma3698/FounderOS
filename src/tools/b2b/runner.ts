// src/tools/b2b/runner.ts
import pLimit from "p-limit";
import { runDiscoveryBatch } from "./discovery-controller";
import { readCleanCompanyNames } from "./company-resolver"; // Phase 1 — CSV in, normalized names out

// Caps how many companies are resolved in parallel so one run doesn't open
// hundreds of connections at once. Tune against your actual Serper plan's
// throughput limit — this is capacity planning, not something to route
// around if it changes.
const CONCURRENCY = 5;
const CHUNK_SIZE = 50;

async function main() {
  const companies = await readCleanCompanyNames("./ind-sponsors-work.csv");
  const limit = pLimit(CONCURRENCY);

  const chunks: string[][] = [];
  for (let i = 0; i < companies.length; i += CHUNK_SIZE) {
    chunks.push(companies.slice(i, i + CHUNK_SIZE));
  }

  let done = 0;
  await Promise.all(
    chunks.map((chunk) =>
      limit(async () => {
        const result = await runDiscoveryBatch(chunk);
        done += chunk.length;
        console.log(`Processed ${done}/${companies.length} — ${result.length} leads found in this chunk`);
      })
    )
  );
}

main().catch(console.error);
