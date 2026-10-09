/**
 * The morning run (AG-051; plan docs/plans/2026-10-08-simplify-founderos.md §5): at 08:00 IST the founder's five daily
 * questions are asked as the founder over MTProto, each reply is scored against the real source by a pure scorer
 * (scripts/lib/journey-score.ts; no model scores anything), journey A-C results are added, then the health line, and
 * ONE message goes to the founder DM. Rows land in agents.journey_runs for the trend.
 *
 *   J1 work inbox · J2 calendar · J3 open PRs (+ follow-up) · J4 not built (waits for the AG-056 job row) · J5 reminder
 *   A: last result from ~/.claude/journey-a.log (its own cron, daily at 01:30 UTC) · B: /where vs GitHub · C: jobs group freshness
 *
 * Installed by deploy (deploy/sync-daemons.sh, ensure_journey_cron) at 02:30 UTC. By hand on the VPS:
 *   node --import tsx/esm --env-file=.env scripts/journey-daily.ts
 * Env: JOURNEY_WORK_ACCOUNT (default "work"), JOURNEY_CALENDAR_ACCOUNT (default the default account),
 *      JOURNEY_WHERE_REPO (default pushkarverma3698/FounderOS), JOBHUNT_CHAT_ID, JOURNEY_MAX_AGE_H (C, default 26).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Api, type TelegramClient } from "telegram";
import { DEFAULT_ACCOUNT_KEY } from "../src/core/accounts.js";
import { DAILY_BUDGET_USD, TENANT } from "../src/core/config.js";
import { closeDatabaseConnections, getDb } from "../src/db/client.js";
import { journeyRuns } from "../src/db/journey-runs-schema.js";
import { appendScreenEntry } from "../src/infra/screen-log.js";
import { isProgressChatter } from "./lib/bot-progress.js";
import { healthLine } from "./lib/health-line.js";
import { judgeJobsGroup } from "./lib/journey-jobs.js";
import * as reads from "./lib/journey-reads.js";
import {
  istDayWindow,
  parseJourneyALog,
  REMINDER_FIRE_LIMIT_MS,
  scoreCalendar,
  scoreInbox,
  scorePrs,
  scoreReminder,
  type Verdict,
} from "./lib/journey-score.js";
import { judgeWhere, parseWhereReply } from "./lib/journey-where.js";
import { composeMorningReport, type JourneyId, type JourneyResult } from "./lib/morning-report.js";
import { assertMtprotoConfigured, connect, POLL_INTERVAL_MS, probePeer, sleep } from "./lib/mtproto.js";
import type { ProbePeer } from "./lib/probe-peer.js";

/** src/core/accounts.ts marks no account as "work" (founder question in the AG-051 PR); this is the guess until he says. */
export const DEFAULT_WORK_ACCOUNT = "work";
/** How long one question may take before it is scored red as "no answer". */
export const ANSWER_WAIT_S = 240;
/** How often the reminder row is re-read while waiting for it to fire. */
const REMINDER_POLL_MS = 15_000;
const J5_ASK = "Remind me in 2 minutes to check the journeys";
const J5_TEXT = "check the journeys";

const REPO = process.env["JOURNEY_WHERE_REPO"] ?? "pushkarverma3698/FounderOS";
const WORK_ACCOUNT = process.env["JOURNEY_WORK_ACCOUNT"] ?? DEFAULT_WORK_ACCOUNT;
const CALENDAR_ACCOUNT = process.env["JOURNEY_CALENDAR_ACCOUNT"] ?? DEFAULT_ACCOUNT_KEY;

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);

/** Send as the founder; return the first message that is not progress chatter (the #1002 rule). */
async function ask(client: TelegramClient, peer: ProbePeer, text: string, waitS = ANSWER_WAIT_S): Promise<string> {
  const sent = await client.sendMessage(peer, { message: text });
  const deadline = Date.now() + waitS * 1_000;
  const seen = new Set<number>();
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const msgs = [...(await client.getMessages(peer, { limit: 20 }))].reverse();
    for (const msg of msgs) {
      if (msg.id <= sent.id || msg.out || seen.has(msg.id)) continue;
      seen.add(msg.id);
      const body = String(msg.message ?? "");
      if (!isProgressChatter(body)) return body;
    }
  }
  throw new Error(`no answer to "${text}" within ${waitS}s`);
}

const fromVerdict = (id: JourneyId, v: Verdict): JourneyResult => ({ id, status: v.ok ? "green" : "red", detail: v.detail });

/** Any throw inside a journey is that journey's red line with its reason, never a crash of the whole run. */
async function journey(id: JourneyId, fn: () => Promise<JourneyResult>): Promise<JourneyResult> {
  try {
    return await fn();
  } catch (err) {
    return { id, status: "red", detail: `could not run: ${reason(err)}` };
  }
}

async function j1(client: TelegramClient, peer: ProbePeer): Promise<JourneyResult> {
  const reply = await ask(client, peer, "Anything important in my work inbox since yesterday?");
  const subjects = await reads.inboxSubjects(WORK_ACCOUNT);
  if ("error" in subjects) return { id: "J1", status: "red", detail: subjects.error };
  return fromVerdict("J1", scoreInbox(reply, subjects));
}

async function j2(client: TelegramClient, peer: ProbePeer): Promise<JourneyResult> {
  const reply = await ask(client, peer, "What's on my calendar today?");
  const events = await reads.calendarTitles(CALENDAR_ACCOUNT, istDayWindow(Date.now(), 0));
  if ("error" in events) return { id: "J2", status: "red", detail: events.error };
  return fromVerdict("J2", scoreCalendar(reply, events));
}

async function j3(client: TelegramClient, peer: ProbePeer): Promise<JourneyResult> {
  const reply = await ask(client, peer, "Which FounderOS PRs are open, and is CI green on them?");
  const followUp = await ask(client, peer, "and the oldest one, what's blocking it?");
  return fromVerdict("J3", scorePrs(reply, followUp, await reads.openPrs(REPO)));
}

/** Waits for the reminder row to fire (up to REMINDER_FIRE_LIMIT_MS after the ask), then asks for the list. */
async function j5Finish(client: TelegramClient, peer: ProbePeer, askedAt: string): Promise<JourneyResult> {
  const until = Date.parse(askedAt) + REMINDER_FIRE_LIMIT_MS;
  let rows = await reads.reminderRows(J5_TEXT, askedAt);
  while (!rows.created?.firedAt && Date.now() < until) {
    await sleep(REMINDER_POLL_MS);
    rows = await reads.reminderRows(J5_TEXT, askedAt);
  }
  const listReply = await ask(client, peer, "What reminders do I have?");
  const after = await reads.reminderRows(J5_TEXT, askedAt);
  return fromVerdict("J5", scoreReminder({ askedAt, created: rows.created, listReply, scheduled: after.scheduled }));
}

async function journeyB(client: TelegramClient, peer: ProbePeer): Promise<JourneyResult> {
  const before = await reads.whereCounts(REPO);
  const reply = await ask(client, peer, `/where ${REPO.split("/")[1] ?? REPO}`, 60);
  const after = await reads.whereCounts(REPO);
  return fromVerdict("B", judgeWhere(parseWhereReply(reply), before, after));
}

async function journeyC(client: TelegramClient): Promise<JourneyResult> {
  const group = process.env["JOBHUNT_CHAT_ID"];
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!group || !token) throw new Error("JOBHUNT_CHAT_ID and TELEGRAM_BOT_TOKEN must be set");
  const msgs = await client.getMessages(Number(group), { limit: 100 });
  const rows = [...msgs]
    .filter((m): m is Api.Message => m instanceof Api.Message)
    .map((m) => ({
      fromId: m.fromId instanceof Api.PeerUser ? Number(m.fromId.userId) : undefined,
      date: m.date,
      text: m.message ?? "(media)",
    }));
  const maxAgeH = Number(process.env["JOURNEY_MAX_AGE_H"] ?? 26);
  return fromVerdict("C", judgeJobsGroup(rows, Number(token.split(":")[0]), Date.now(), maxAgeH));
}

function journeyA(): JourneyResult {
  const file = `${process.env["HOME"] ?? ""}/.claude/journey-a.log`;
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = undefined; // allow-failopen: a missing log is scored red ("no journey A log on this host") by parseJourneyALog
  }
  const r = parseJourneyALog(text, Date.now());
  return { id: "A", ...r };
}

async function notifyFounder(chunks: readonly string[]): Promise<number> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chat = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set to send the morning message");
  let sent = 0;
  for (const text of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    if (!res.ok) throw new Error(`Telegram refused part ${sent + 1} of the morning message: HTTP ${res.status}`);
    sent++;
    // The bot's planner reads the screen log, so "why is J2 red?" gets an answer.
    await appendScreenEntry({ chat, src: "journey-daily", text });
  }
  return sent;
}

function creditLine(before: Awaited<ReturnType<typeof reads.readOpenRouter>>, after: typeof before): string {
  if ("error" in before || "error" in after) return "OpenRouter credit used by this run: unknown (a balance read failed).";
  const used = Math.max(0, before.balanceUsd - after.balanceUsd);
  return `OpenRouter credit used by this run: $${used.toFixed(2)} (balance $${before.balanceUsd.toFixed(2)} → $${after.balanceUsd.toFixed(2)}).`;
}

async function main(): Promise<void> {
  const runId = randomUUID();
  const startedAt = Date.now();
  const creditBefore = await reads.readOpenRouter();
  assertMtprotoConfigured();
  const client = await connect();
  const results: JourneyResult[] = [];
  try {
    const peer = await probePeer(client);
    // J5 first: the reminder fires while J1-J3 run, so the run does not sit idle for two minutes.
    const askedAt = new Date().toISOString();
    const j5Ask = await journey("J5", async () => {
      await ask(client, peer, J5_ASK);
      return { id: "J5", status: "green", detail: "asked" };
    });
    results.push(await journey("J1", () => j1(client, peer)));
    results.push(await journey("J2", () => j2(client, peer)));
    results.push(await journey("J3", () => j3(client, peer)));
    results.push({ id: "J4", status: "not_built", detail: "waits for AG-056 job row" });
    results.push(j5Ask.status === "red" ? j5Ask : await journey("J5", () => j5Finish(client, peer, askedAt)));
    results.push(journeyA());
    results.push(await journey("B", () => journeyB(client, peer)));
    results.push(await journey("C", () => journeyC(client)));
  } finally {
    await client.disconnect();
  }

  const [openRouter, aiStudio, claude, google, units, spend] = await Promise.all([
    reads.readOpenRouter(),
    reads.readAiStudio(),
    reads.readClaude(),
    reads.readGoogle(),
    reads.readUnits(),
    reads.readSpend(istDayWindow(Date.now(), -1), DAILY_BUDGET_USD),
  ]);
  const health = healthLine({ openRouter, aiStudio, claude, google, units, killSwitches: reads.readKillSwitches(), spend });

  let stored = `${results.length} rows stored in agents.journey_runs`;
  try {
    await getDb()
      .insert(journeyRuns)
      .values(results.map((r) => ({ tenant_id: TENANT, run_id: runId, journey: r.id, status: r.status, health_ok: health.ok, detail: r.detail })));
  } catch (err) {
    stored = `journey_runs insert failed: ${reason(err)}`; // allow-failopen: the morning message still goes out and names the failed insert
  }

  const credit = creditLine(creditBefore, openRouter);
  const chunks = composeMorningReport(results, health, `${credit} ${stored}.`);
  for (const c of chunks) console.log(c);
  const parts = await notifyFounder(chunks);
  const tookS = Math.round((Date.now() - startedAt) / 1000);
  console.log(`journey-daily run ${runId}: ${parts} message part(s) sent in ${tookS}s. ${credit}`);
  if (results.some((r) => r.status === "red") || !health.ok) process.exitCode = 1;
}

main()
  .catch(async (err: unknown) => {
    console.error(`journey-daily could not run: ${reason(err)}`);
    await notifyFounder([`🔴 The morning journey run could not run: ${reason(err)}`]).catch(() => 0); // allow-failopen: already failing; stderr has the reason
    process.exitCode = 1;
  })
  .finally(() => closeDatabaseConnections());
