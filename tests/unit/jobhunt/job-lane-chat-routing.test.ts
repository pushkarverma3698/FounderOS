/**
 * The job lane never sends through the founder-chat helpers. `sendToChat` is the system channel (budget
 * alerts, approval reminders, dispatch notices); a job message sent through it lands in the founder's private
 * chat and the family jobs group never sees it, which is how every job message was routed until 2026-10-02.
 *
 * Reading the source is the mechanism. A new job sender copied from an old one fails here, in CI, instead of
 * in a sweep nobody is watching. Comments are stripped first so a comment can still name the helper.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : rel.endsWith(".ts") ? [rel] : [];
  });
}

const withPrefix = (dir: string, prefix: string): string[] =>
  readdirSync(join(ROOT, dir))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".ts"))
    .map((name) => `${dir}/${name}`);

/** Every file that belongs to the job lane: the tools, the 09:30 check, and the job chat commands. */
const JOB_LANE = [
  ...walk("src/tools/jobhunt"),
  ...withPrefix("src/evolution", "jobhunt-"),
  ...withPrefix("src/gateway", "jobhunt-"),
];

/** The code, without comments: a comment may say `sendToChat`, a call may not. */
function code(file: string): string {
  return readFileSync(join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The three files that speak to the candidates on their own, with no founder message to answer. */
const PROACTIVE_SENDERS = [
  "src/tools/jobhunt/sweep-runner.ts",
  "src/tools/jobhunt/free-sweep-profile.ts",
  "src/tools/jobhunt/pipeline-followup.ts",
];

/**
 * The 09:30 check is a report to the founder, not a message to the candidates: it says how to relabel an
 * issue, what to change in `.env`, when to `/resume`, and which database call failed, and its decisions
 * block speaks to the founder about "the candidate". It stays in his private chat.
 */
const OPERATOR_REPORT = "src/evolution/jobhunt-check.ts";

describe("job lane chat routing", () => {
  it("finds the files it guards, so a moved directory cannot make this pass with nothing to read", () => {
    expect(JOB_LANE.length).toBeGreaterThan(30);
    for (const file of PROACTIVE_SENDERS) expect(JOB_LANE).toContain(file);
  });

  it.each(JOB_LANE.filter((file) => file !== OPERATOR_REPORT))("%s does not send to the founder's chat", (file) => {
    expect(code(file)).not.toMatch(/\b(sendToChat|sendToChatWithKeyboard|defaultChatId|TELEGRAM_CHAT_ID)\b/);
  });

  it.each(PROACTIVE_SENDERS)("%s sends through the jobs chat", (file) => {
    expect(code(file)).toMatch(/\bsendToJobsChat\b/);
  });
});

describe("the 09:30 check stays in the founder's chat", () => {
  it("is in the job lane, so a moved file cannot make this pass with nothing to read", () => {
    expect(JOB_LANE).toContain(OPERATOR_REPORT);
  });

  it("sends through the system channel and never through the jobs chat", () => {
    expect(code(OPERATOR_REPORT)).toMatch(/\bsendToChat\b/);
    expect(code(OPERATOR_REPORT)).not.toMatch(/\bsendToJobsChat\b/);
  });
});
