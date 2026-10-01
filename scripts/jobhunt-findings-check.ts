/**
 * Jobhunt findings check: READ-ONLY dry run.
 * ===========================================
 *   node --env-file=.env --import tsx/esm scripts/jobhunt-findings-check.ts
 *
 * Prints what the daily 09:30 check would say RIGHT NOW: the Telegram message, and
 * the issue it would file. It files nothing, sends nothing and writes nothing.
 * Reads the jobhunt tables, GitHub's issue history (so "would file" means would
 * file after the dedupe) and the decision memory.
 *
 * It cannot act on purpose. "At most one issue a day" is kept by the loop filing
 * one per run and the cron running once a day; an entry point that could file by
 * hand would be a second way in. The only thing that files is the cron
 * (src/evolution/jobhunt-findings-cron.ts).
 *
 * Exit 1 when the check itself failed, so a wrapper can tell a clean read from a
 * broken one.
 */

import { closeDatabaseConnections } from "../src/db/client.js";
import { octokitIssueGateway } from "../src/evolution/dispatch-findings.js";
import { runJobhuntFindingsCheck } from "../src/evolution/jobhunt-check.js";
import type { JobhuntCheckDeps } from "../src/evolution/jobhunt-check.js";
import { loadNotifyState } from "../src/evolution/jobhunt-notify-state.js";

/** Runs the check with every side effect replaced by a printout. Returns the process exit code. */
export async function runDryRun(overrides: Partial<JobhuntCheckDeps> = {}): Promise<number> {
  const wouldFile: string[] = [];
  console.log("DRY RUN: nothing below was filed, sent or written. `#0` is a placeholder for an issue number.\n");

  const result = await runJobhuntFindingsCheck({
    gateway: () => {
      const real = octokitIssueGateway();
      return {
        listAutoFiledBodies: () => real.listAutoFiledBodies(),
        createIssue: async ({ title, labels }) => {
          wouldFile.push(`${title}  [labels: ${labels.join(", ")}]`);
          return { number: 0, url: "(dry run: nothing was filed)" };
        },
      };
    },
    send: async (parts) => {
      parts.forEach((part, i) => console.log(`--- Telegram message ${i + 1} of ${parts.length} (NOT sent) ---\n${part}\n`));
    },
    state: {
      load: () => loadNotifyState(),
      save: async () => {
        console.log("(decision memory not written)");
      },
    },
    ...overrides,
  });

  if (wouldFile.length > 0) console.log(`WOULD FILE: ${wouldFile[0]}`);
  else console.log(`Would file nothing (${result.outcome.state}).`);
  return result.outcome.state === "failed" ? 1 : 0;
}

const isMain = process.argv[1]?.endsWith("jobhunt-findings-check.ts");
if (isMain) {
  runDryRun()
    .then(async (code) => {
      await closeDatabaseConnections();
      process.exit(code);
    })
    .catch(async (err: unknown) => {
      console.error("Dry run crashed:", err instanceof Error ? err.message : err);
      await closeDatabaseConnections();
      process.exit(2);
    });
}
