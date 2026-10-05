/**
 * Golden journey C (30-day plan, 2026-10-03 → 11-01): a job message lands in the jobs group.
 * Reads the group as the founder over MTProto ($0, no model call) and checks the bot posted
 * within JOURNEY_MAX_AGE_H (default 26h: one daily sweep plus slack). Red → one line to the
 * founder DM and exit 1. Run nightly from the founderos crontab on the VPS:
 *
 *   node --import tsx/esm --env-file=.env scripts/journey-jobs-group.ts
 */
import { Api } from "telegram";
import { connect } from "./lib/mtproto.js";
import { judgeJobsGroup } from "./lib/journey-jobs.js";
import { appendScreenEntry } from "../src/infra/screen-log.js";

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
  if (res.ok) await appendScreenEntry({ chat, src: "journey-jobs-group", text });
}

async function main(): Promise<void> {
  const group = process.env["JOBHUNT_CHAT_ID"];
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!group || !token) throw new Error("JOBHUNT_CHAT_ID and TELEGRAM_BOT_TOKEN must be set");
  const botId = Number(token.split(":")[0]);
  const maxAgeH = Number(process.env["JOURNEY_MAX_AGE_H"] ?? 26);

  const client = await connect();
  try {
    const msgs = await client.getMessages(Number(group), { limit: 100 });
    const rows = [...msgs]
      .filter((m): m is Api.Message => m instanceof Api.Message)
      .map((m) => ({
        fromId: m.fromId instanceof Api.PeerUser ? Number(m.fromId.userId) : undefined,
        date: m.date,
        text: m.message ?? "(media)",
      }));
    const verdict = judgeJobsGroup(rows, botId, Date.now(), maxAgeH);
    console.log(`${verdict.ok ? "GREEN" : "RED"} journey C (jobs group): ${verdict.detail}`);
    if (!verdict.ok) {
      await notifyFounder(`🔴 Golden journey C is red: ${verdict.detail}. Fixing it is tomorrow's only work.`);
      process.exitCode = 1;
    }
  } finally {
    await client.disconnect();
  }
}

main().catch(async (err: unknown) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`RED journey C: ${reason}`);
  await notifyFounder(`🔴 Golden journey C could not run: ${reason}`);
  process.exit(1);
});
