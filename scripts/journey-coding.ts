/**
 * Golden journey A (30-day plan, 2026-10-03 → 11-01): a coding task ends in a PR whose CI is green.
 * Files a complete brief as an agent:ready issue on the private sandbox repo, waits for the VPS
 * agent-dispatch loop (agy → draft PR) and reads the PR's checks. Then closes the PR and the issue.
 * $0 of FounderOS model spend; it does use one agy run. Red → one line to the founder DM, exit 1.
 * It starts at the issue: the Telegram `/task` card in front of it is not exercised.
 * Run every 3 nights from the founderos crontab on the VPS:
 *
 *   node --import tsx/esm --env-file=.env scripts/journey-coding.ts
 */
import { judgeCoding, sandboxBrief, type JourneyAVerdict } from "./lib/journey-coding.js";
import { appendScreenEntry } from "../src/infra/screen-log.js";

const REPO = process.env["JOURNEY_CODING_REPO"] ?? "pushkarverma3698/fos-journey-sandbox";
const LIMIT_MIN = Number(process.env["JOURNEY_CODING_LIMIT_MIN"] ?? 45);
const POLL_MS = 60_000;

async function notifyFounder(text: string): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chat = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chat) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  });
  // The bot's planner reads the screen log, so a follow-up question about this alert gets an answer.
  if (res.ok) await appendScreenEntry({ chat, src: "journey-coding", text });
}

async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN must be set");
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} ${res.status}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

interface Pr { number: number; head: { ref: string; sha: string } }

async function cleanup(issue: number): Promise<void> {
  const prs = await gh<Pr[]>("GET", "/pulls?state=open&per_page=100");
  for (const pr of prs.filter((p) => p.head.ref.startsWith(`task/issue-${issue}-`))) {
    await gh("PATCH", `/pulls/${pr.number}`, { state: "closed" });
    await gh("DELETE", `/git/refs/heads/${pr.head.ref}`).catch(() => undefined);
  }
  await gh("PATCH", `/issues/${issue}`, { state: "closed" });
}

async function main(): Promise<void> {
  // A leftover issue from a crashed run would be claimed first and confuse this one.
  const stale = await gh<{ number: number; pull_request?: unknown }[]>("GET", "/issues?state=open&labels=journey&per_page=50");
  for (const s of stale.filter((i) => !i.pull_request)) await cleanup(s.number);

  const stamp = new Date().toISOString().slice(0, 16) + "Z";
  const issue = await gh<{ number: number }>("POST", "/issues", {
    title: `journey A ${stamp}`,
    body: sandboxBrief(stamp),
    labels: ["journey", "agent:ready"],
  });
  const started = Date.now();
  let verdict: JourneyAVerdict = { done: false, ok: false, detail: "waiting" };
  try {
    while (!verdict.done) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const waitedMin = Math.round((Date.now() - started) / 60_000);
      const labels = (await gh<{ labels: { name: string }[] }>("GET", `/issues/${issue.number}`)).labels.map((l) => l.name);
      const prs = await gh<Pr[]>("GET", "/pulls?state=open&per_page=100");
      const pr = prs.find((p) => p.head.ref.startsWith(`task/issue-${issue.number}-`));
      const checks = pr
        ? (await gh<{ check_runs: { conclusion: string | null }[] }>("GET", `/commits/${pr.head.sha}/check-runs?per_page=100`)).check_runs.map((c) => c.conclusion)
        : [];
      verdict = judgeCoding({ prBranch: pr?.head.ref, checks, labels: labels.filter((l) => l.startsWith("agent:")), waitedMin, limitMin: LIMIT_MIN });
    }
  } finally {
    await cleanup(issue.number).catch((e: unknown) => console.error(`cleanup of #${issue.number} failed: ${String(e)}`));
  }
  console.log(`${verdict.ok ? "GREEN" : "RED"} journey A (${REPO}): ${verdict.detail}`);
  if (!verdict.ok) {
    await notifyFounder(`🔴 Golden journey A is red: ${verdict.detail}. Fixing it is tomorrow's only work.`);
    process.exitCode = 1;
  }
}

main().catch(async (err: unknown) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`RED journey A: ${reason}`);
  await notifyFounder(`🔴 Golden journey A could not run: ${reason}`);
  process.exit(1);
});
