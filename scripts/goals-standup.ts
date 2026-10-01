/**
 * FounderOS — goals: run the daily standup by hand
 * ================================================
 *   pnpm goals:standup --now       run today's standup now — the SAME function the 09:00 cron runs, so it is
 *                                  just as idempotent: run it twice and it sends once, and it never re-sends a
 *                                  goal that was delivered
 *   pnpm goals:standup --dry-run   print what would be sent; claims, stores and sends nothing
 *
 * Zero LLM. Exit code 0 when the day is handled (sent, nothing to send, already delivered, halted), 1 when it
 * is not (a failed send, or another run still holds the claim), 2 for a usage error.
 *
 * `runGoalsStandupCli` takes its dependencies as a parameter so it can be driven with a fake Telegram sender
 * and a fake GitHub client: the real-path proof does exactly that against a real Postgres.
 */

import { runStandup, type StandupDeps, type StandupOutcome } from "../src/goals/standup.js";

const USAGE = [
  "Usage: pnpm goals:standup --now | --dry-run",
  "  --now      run today's standup now (idempotent: nothing already delivered is sent again)",
  "  --dry-run  print what would be sent; claims, stores and sends nothing",
].join("\n");

async function defaultMakeDeps(): Promise<StandupDeps> {
  return (await import("../src/goals/standup-deps.js")).createStandupDeps();
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

function report(outcome: StandupOutcome, out: (line: string) => void): number {
  switch (outcome.kind) {
    case "sent":
      out(`Goal standup: sent ${plural(outcome.messages, "message")} covering ${plural(outcome.goals, "goal")}.`);
      if (outcome.done.length > 0) out(`Finished and marked done: ${outcome.done.join(", ")}.`);
      if (outcome.retryAfterMs !== null) out(`Some goals are held by another run; run again in ${Math.ceil(outcome.retryAfterMs / 1000)}s to pick them up.`);
      return 0;
    case "nothing-due":
      out("Goal standup: nothing to send, there are no open goals.");
      return 0;
    case "already-sent":
      out("Goal standup: nothing to send, today's standup was already delivered.");
      return 0;
    case "in-progress":
      out(`Goal standup: another run holds today's standup; its claim expires in ${Math.ceil(outcome.retryAfterMs / 1000)}s. Run again then.`);
      return 1;
    case "halted":
      out(`Goal standup: FounderOS is halted, so nothing was sent. ${outcome.date} is recorded as skipped and reported at /resume.`);
      return 0;
    case "send-failed":
      out(`Goal standup: NOT sent (${plural(outcome.sentMessages, "message")} delivered before it failed): ${outcome.error}. Fix the cause and run again; delivered messages are not re-sent.`);
      return 1;
    case "dry-run":
      outcome.messages.forEach((message, i) => {
        out(`--- message ${i + 1} of ${outcome.messages.length} (${plural(message.goalIds.length, "goal")}) ---`);
        out(message.text);
        for (const button of message.keyboard.flat()) out(`[button] ${button.text} -> ${button.callback_data}`);
      });
      return 0;
  }
}

/** Run the CLI. Returns the process exit code; never calls process.exit itself. */
export async function runGoalsStandupCli(
  argv: readonly string[],
  makeDeps: () => Promise<StandupDeps> = defaultMakeDeps,
  out: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const flag = argv[0];
  if (argv.length !== 1 || (flag !== "--now" && flag !== "--dry-run")) {
    out(USAGE);
    return 2;
  }
  const outcome = await runStandup(await makeDeps(), { dryRun: flag === "--dry-run" });
  return report(outcome, out);
}

if (process.argv[1]?.endsWith("goals-standup.ts")) {
  const finish = async (code: number): Promise<never> => {
    const { closeDatabaseConnections } = await import("../src/db/client.js");
    await closeDatabaseConnections();
    process.exit(code);
  };
  runGoalsStandupCli(process.argv.slice(2)).then(finish, async (err: unknown) => {
    console.error("Goal standup failed:", err instanceof Error ? err.message : String(err));
    await finish(1);
  });
}
