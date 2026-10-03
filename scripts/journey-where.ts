/**
 * Golden journey B (30-day plan, 2026-10-03 → 11-01): "where are we" returns numbers that match GitHub.
 * Sends `/where <repo>` to the bot as the founder over MTProto, then compares the reply with GitHub's
 * search API read before and after ($0, no model call). Red → one line to the founder DM and exit 1.
 * Run nightly from the founderos crontab on the VPS:
 *
 *   node --import tsx/esm --env-file=.env scripts/journey-where.ts
 */
import { botUsername, connect, sendAndCollect } from "./lib/mtproto.js";
import { judgeWhere, parseWhereReply, type WhereCounts } from "./lib/journey-where.js";

const REPO = process.env["JOURNEY_WHERE_REPO"] ?? "pushkarverma3698/FounderOS";
const WEEK_MS = 7 * 24 * 3_600_000;

async function notifyFounder(text: string): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chat = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  });
}

async function searchCount(q: string): Promise<number> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN must be set");
  const res = await fetch(`https://api.github.com/search/issues?per_page=1&q=${encodeURIComponent(q)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub search ${res.status}`);
  return ((await res.json()) as { total_count: number }).total_count;
}

async function githubCounts(): Promise<WhereCounts> {
  const since = new Date(Date.now() - WEEK_MS).toISOString().replace(/\.\d+Z$/, "Z");
  const [done, openPrs, left] = await Promise.all([
    searchCount(`repo:${REPO} is:pr is:merged merged:>=${since}`),
    searchCount(`repo:${REPO} is:pr is:open`),
    searchCount(`repo:${REPO} is:issue is:open`),
  ]);
  return { done, openPrs, left };
}

async function main(): Promise<void> {
  const before = await githubCounts();
  const client = await connect();
  let replies: string[];
  try {
    const sent = await sendAndCollect(client, await botUsername(), `/where ${REPO.split("/")[1]}`, 60);
    if (sent.sendError) throw new Error(`could not send /where: ${sent.sendError}`);
    replies = sent.replies.map((r) => r.text);
  } finally {
    await client.disconnect();
  }
  const after = await githubCounts();
  const reply = parseWhereReply(replies.join("\n"));
  const verdict = judgeWhere(reply, before, after);
  console.log(`${verdict.ok ? "GREEN" : "RED"} journey B (/where ${REPO}): ${verdict.detail}`);
  if (!verdict.ok) {
    await notifyFounder(`🔴 Golden journey B is red: ${verdict.detail}. Fixing it is tomorrow's only work.`);
    process.exitCode = 1;
  }
}

main().catch(async (err: unknown) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`RED journey B: ${reason}`);
  await notifyFounder(`🔴 Golden journey B could not run: ${reason}`);
  process.exit(1);
});
