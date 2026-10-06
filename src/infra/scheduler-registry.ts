/**
 * FounderOS — the bot's built-in routines, in the words the founder is told them in
 * ================================================================================
 * "What's running?" needs the schedules the bot keeps for itself. scheduler.ts registers them with inline
 * cron.schedule() calls, and rewriting those to feed a registry would touch every sweep. So this list is kept next to
 * it and tests/unit/infra/scheduler-registry.test.ts fails, naming the missing cron, when scheduler.ts adds, changes
 * or removes one without this file following. The words are the only hand-written part; the schedule shown is the
 * cron expression below, rendered by describeCron().
 */

export interface ScheduledRoutine {
  readonly id: string;
  /** What the founder sees as the routine's name. */
  readonly title: string;
  /** Exactly the expression passed to cron.schedule(). */
  readonly cron: string;
  /** Where it is registered: scheduler.ts itself, or the module that calls cron.schedule() on its own. */
  readonly source: string;
  /** One plain sentence about what it does for the founder. */
  readonly what: string;
}

export const SCHEDULED_ROUTINES: readonly ScheduledRoutine[] = [
  { id: "reminders", title: "Reminders", cron: "* * * * *", source: "scheduler.ts", what: "Sends your reminders when they are due." },
  { id: "scheduled-tasks", title: "Scheduled tasks", cron: "* * * * *", source: "scheduler.ts", what: "Runs the tasks you scheduled when they are due." },
  { id: "scheduled-posts", title: "Scheduled posts", cron: "* * * * *", source: "scheduler.ts", what: "Publishes the LinkedIn posts you scheduled when their time comes." },
  { id: "free-board-sweep", title: "Job-board check", cron: "*/30 * * * *", source: "scheduler.ts", what: "Checks every job board for new roles and messages you only when something is worth seeing." },
  { id: "spend-and-checker-alerts", title: "Spend and checker alerts", cron: "0 * * * *", source: "scheduler.ts", what: "Warns you when today's AI spend nears the cap, or when the answer checker is down." },
  { id: "brain-sync", title: "Knowledge sync", cron: "0 2 * * *", source: "scheduler.ts", what: "Syncs the knowledge base so search never goes stale." },
  { id: "funding-grower", title: "Job-board list growth", cron: "0 2 * * *", source: "scheduler.ts", what: "Adds new companies to the job-board list from funding news." },
  { id: "checkpoint-cleanup", title: "Checkpoint cleanup", cron: "30 3 * * *", source: "scheduler.ts", what: "Clears out old conversation checkpoints that nobody has touched for a long time." },
  { id: "stale-approvals", title: "Approval reminder", cron: "0 9 * * *", source: "scheduler.ts", what: "Reminds you when an approval card has been waiting for more than an hour." },
  { id: "goal-standup", title: "Goal standup", cron: "0 9 * * *", source: "goal-standup", what: "Sends your daily goal standup." },
  { id: "followups", title: "Application follow-ups", cron: "0 9 * * *", source: "scheduler.ts", what: "Drafts a follow-up when a job application has had no reply for 7 or 14 days." },
  { id: "jobhunt-findings", title: "Job-hunt health check", cron: "30 9 * * *", source: "jobhunt-findings", what: "Checks how the job hunt is going and flags a problem at most once a day." },
  { id: "jobhunt-pretailor", title: "Morning CV prep", cron: "30 5 * * *", source: "jobhunt-pretailor", what: "Gets the CV and cover letter ready for your top 3 roles of each profile, so the Draft button answers at once. Sends nothing." },
  { id: "claude-login-expiry", title: "Claude login expiry warning", cron: "15 10 * * *", source: "claude-login-expiry", what: "Warns you 3 days before the Claude login saved on the server stops renewing, once per expiry." },
  { id: "pipeline-digest", title: "Weekly applications review", cron: "0 9 * * 1", source: "scheduler.ts", what: "Sends a weekly review of your job applications." },
  { id: "merge-digest", title: "Evening merge list", cron: "0 19 * * *", source: "merge-digest-run", what: "Sends one message listing the pull requests that are reviewed and ready for you to merge, each with a Merge button." },
  { id: "import-boards-reminder", title: "Board-list refresh reminder", cron: "0 10 1 * *", source: "scheduler.ts", what: "Reminds you on the 1st of the month to refresh the sponsor job-board list." },
];

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const hhmm = (h: string, m: string): string | null =>
  Number(h) <= 23 && Number(m) <= 59 ? `${h.padStart(2, "0")}:${m.padStart(2, "0")}` : null;

/** The cron shapes the registry uses, in words. Anything else is shown as the expression: never a guess. */
export function describeCron(expr: string): string {
  if (expr === "* * * * *") return "every minute";
  if (expr === "0 * * * *") return "every hour";
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(expr);
  if (every) return `every ${every[1]} minutes`;
  const daily = /^(\d+) (\d+) \* \* \*$/.exec(expr);
  if (daily) {
    const t = hhmm(daily[2]!, daily[1]!);
    if (t) return `daily at ${t}`;
  }
  const weekly = /^(\d+) (\d+) \* \* ([0-6])$/.exec(expr);
  if (weekly) {
    const t = hhmm(weekly[2]!, weekly[1]!);
    if (t) return `${DAYS[Number(weekly[3])]} at ${t}`;
  }
  const monthly = /^(\d+) (\d+) 1 \* \*$/.exec(expr);
  if (monthly) {
    const t = hhmm(monthly[2]!, monthly[1]!);
    if (t) return `on the 1st of each month at ${t}`;
  }
  return `cron ${expr}`;
}
