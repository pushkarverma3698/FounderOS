/**
 * FounderOS — what the agents and the founder did recently, from the brain (AG-029).
 *
 *   pnpm brain:digest --since <ISO|36h> [--project <name>]
 *
 * Prints the same dated lines the planner sees (src/kernel/recent-activity.ts), plus Telegram turns
 * (origin "telegram") for the window, newest first, at most 40 lines. One SQL query, $0: no embedding, no LLM.
 * scripts/mac/session-start-digest.sh runs this over SSH at the start of a Mac Claude session.
 *
 * Exit codes: 0 printed (even when empty), 1 bad arguments, 2 the read failed.
 */
import { AGENT_ORIGINS, DIGEST_MAX_LINES, parseDigestArgs, renderDigest } from "../src/kernel/recent-activity.js";
import { readRecentBrainActivity } from "../src/db/recent-activity.js";
import { closeDatabaseConnections } from "../src/db/client.js";

/** Origins the digest reads: the agents' work plus what the founder asked in Telegram. */
const DIGEST_ORIGINS: readonly string[] = [...AGENT_ORIGINS, "telegram"];

async function main(): Promise<number> {
  const now = new Date();
  const args = parseDigestArgs(process.argv.slice(2), now);
  if (typeof args === "string") {
    process.stderr.write(`${args}\n`);
    return 1;
  }
  const rows = await readRecentBrainActivity({
    now,
    since: args.since,
    origins: DIGEST_ORIGINS,
    ...(args.project ? { project: args.project } : {}),
  });
  process.stdout.write(`${renderDigest(rows, DIGEST_MAX_LINES)}\n`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDatabaseConnections().catch(() => undefined); // allow-failopen: script teardown
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`brain-digest: read failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
