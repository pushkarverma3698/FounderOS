/**
 * $0 deep-test of `/ask N` and `/draft N` against the LIVE application table.
 *
 * Exercises everything the Telegram command does EXCEPT the final model call:
 * argument parsing, section+rank resolution, and the instruction the kernel
 * would receive. The model call is the only part that costs money, and it is
 * also the only part that cannot be wrong in a way this script would miss —
 * a wrong ROW is the expensive failure, and that is resolved here in pure code.
 *
 *   pnpm tsx scripts/jobhunt-ask-probe.ts
 */

import { getApplicationByBriefRank } from "../src/db/job-queries.js";
import { parseRowArg, unresolvedMessage } from "../src/gateway/jobhunt-commands.js";
import { askInstruction, draftInstruction } from "../src/gateway/jobhunt-instructions.js";

const RULE = "─".repeat(78);

async function probe(command: "ask" | "draft", raw: string): Promise<void> {
  const section = command === "ask" ? "ask" : "do_today";
  const rank = parseRowArg(raw);
  console.log(`\n${RULE}\n/${command} ${JSON.stringify(raw)}  →  rank=${rank ?? "null"}`);

  if (rank === null) {
    console.log(`REPLY (no kernel turn, no cost):\n${unresolvedMessage(command, null)}`);
    return;
  }

  const row = await getApplicationByBriefRank(section, rank);
  if (!row) {
    console.log(`REPLY (no kernel turn, no cost):\n${unresolvedMessage(command, rank)}`);
    return;
  }

  console.log(`RESOLVED ROW: ${row.company} — ${row.title}`);
  console.log(`  id=${row.id}  section=${row.brief_section}  rank=${row.brief_rank}`);
  console.log(`  verdict=${row.salary_status}  route=${row.route}  liveness=${row.liveness}`);
  console.log(`\nINSTRUCTION HANDED TO THE KERNEL:\n`);
  const instruction = command === "ask" ? askInstruction(row) : draftInstruction(row);
  // Truncated: /draft embeds up to 6k chars of the posting body.
  console.log(instruction.length > 1200 ? `${instruction.slice(0, 1200)}\n…[+${instruction.length - 1200} chars]` : instruction);
}

async function main(): Promise<void> {
  for (const raw of ["1", "2", "3", "4", "abc", "", "0", " 2 "]) {
    await probe("ask", raw);
  }
  await probe("draft", "1");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Probe failed:", (err as Error).message);
    process.exit(1);
  });
