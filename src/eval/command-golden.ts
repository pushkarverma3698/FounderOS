/**
 * FounderOS — plain words → slash command golden set
 * ====================================================
 * Opt-in slice (like CREATIVE_GOLDEN_TASKS): `pnpm eval -- --commands` runs it against the live
 * planner, and is how a candidate model earns a place in a pool. Each task is one plain sentence
 * the founder would really type. Scored on the command NAME only; args belong to the command.
 *
 * The last block is the other half of the contract: sentences that must NOT become a command
 * (typed-only /reset, several steps, reasoning over output, a missing argument).
 */

import type { GoldenTask } from "./types.js";

const cmd = (id: string, input: string, expectedCommand: string): GoldenTask => ({
  id: `cmd-${id}`,
  input,
  expectedRoute: null,
  expectedCommand,
});

const notCmd = (id: string, input: string, note: string, expectedRoute: GoldenTask["expectedRoute"] = null): GoldenTask => ({
  id: `nocmd-${id}`,
  input,
  expectedRoute,
  note,
});

export const COMMAND_GOLDEN_TASKS: GoldenTask[] = [
  cmd("where-oplify", "where are we on oplify", "where"),
  cmd("where-all", "give me the status of every repo, what's done and what's stuck", "where"),
  cmd("tasks-loop", "what is the agent loop doing right now", "tasks"),
  cmd("tasks-queue", "is anything queued or blocked in the build queue", "tasks"),
  cmd("task-fix", "fix the login bug in oplify", "task"),
  cmd("task-build", "build a dark mode toggle for the founderos dashboard", "task"),
  cmd("jobs-all", "show me every job you have on file", "jobs"),
  cmd("jobs-3d", "jobs from the last 3 days please", "jobs"),
  cmd("today-new", "any roles published in the last 24 hours?", "today"),
  cmd("fresh-new", "what has come in since I last looked", "fresh"),
  cmd("csv-queue", "give me the apply queue as a spreadsheet", "csv"),
  cmd("gaps-cv", "which keywords does the market want that my CV is missing", "gaps"),
  cmd("draft-3", "tailor a CV and cover letter for job 3", "draft"),
  cmd("ask-5", "what is the one question that unblocks row 5", "ask"),
  cmd("applied-2", "I applied to number 2, drop it off the queue", "applied"),
  cmd("replied-4", "number 4 wrote back to me", "replied"),
  cmd("rejected-1", "row 1 rejected me", "rejected"),
  cmd("profile-show", "what do my application forms get filled from", "profile"),
  cmd("status-health", "is the system healthy and are there approvals waiting for me", "status"),
  cmd("budget-spend", "how much have I spent today against the cap", "budget"),
  cmd("focus-show", "what am I supposed to be focused on", "focus"),
  cmd("projects-show", "list my active projects", "projects"),
  cmd("goals-show", "how am I doing against my goals", "goals"),
  cmd("goal-add", "my goal this month is 20 applications", "goal"),
  cmd("newproject-site", "start a new project called naggar-site, a brochure site for a client", "newproject"),
  cmd("commands-list", "what can you do, list every command", "commands"),
  cmd("halt-stop", "stop everything right now, refuse all new work", "halt"),
  cmd("resume-go", "lift the halt, you can take work again", "resume"),
  cmd("connect-mcp", "find and add an MCP server for notion", "connect"),
  cmd("jobs-tashi", "show Tashi's jobs", "jobs"),

  notCmd("reset", "wipe this thread and start over", "/reset is typed-only: plain words never reach it"),
  notCmd("multi", "show me where oplify stands and then draft cover letters for the top three jobs", "two commands plus reasoning is a plan", "jobhunt"),
  notCmd("reason", "look at what the agent loop is doing and tell me which blocked task I should unblock first", "reasoning over a command's output is a plan, not a command", "engineering"),
  notCmd("missing-arg", "mark one of them as applied", "the row number is missing: ask for it, never guess"),
  notCmd("remind-call", "remind me to call the landlord at 3pm", "/remind's handler is a planner turn: routing to it loops (QA 2026-10-09); plan set_reminder", "admin"),
  notCmd("chat", "thanks, that was helpful", "small talk is a direct reply"),
  notCmd("research", "research what Stripe does and summarise it in two lines", "open research is a plan", "research"),
];
