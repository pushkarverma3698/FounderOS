/**
 * The reads behind the morning run (AG-051): the real sources each journey is scored against, and the health reads.
 * I/O only, no scoring: every function returns data or { error } with the reason, and scripts/lib/journey-score.ts
 * and scripts/lib/health-line.ts decide. Split from scripts/journey-daily.ts to keep both under 400 lines.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { defaultGwsProfileDir, isBuiltinGoogleAccount } from "../../src/core/accounts.js";
import { getDb } from "../../src/db/client.js";
import { listGoogleMailboxes, mailboxProfileDir } from "../../src/infra/google-mailboxes.js";
import { runGws } from "../../src/infra/gws-runner.js";
import { extractGwsMessageIds } from "../../src/tools/email-messages.js";
import { fetchGwsMessages } from "../../src/tools/gmail-gws-read.js";
import { summarizeChecks } from "../../src/tools/github-pr.js";
import { CLAUDE_PROBE_CMD, gwsErrorLine, type GoogleRead, type HealthReads } from "./health-line.js";
import type { InboxMail, OpenPr } from "./journey-score.js";
import type { WhereCounts } from "./journey-where.js";

const run = promisify(execFile);
const GWS_TIMEOUT_MS = 30_000;
/** At most this many subjects are fetched for J1: one match is enough, and each is one gws call. */
const INBOX_SUBJECTS_MAX = 15;
const WEEK_MS = 7 * 24 * 3_600_000;

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);
type Failed = { error: string };

export function gwsDir(account: string): string {
  return isBuiltinGoogleAccount(account) ? defaultGwsProfileDir("personal") : mailboxProfileDir(account);
}

/** J1 truth: subject and sender of the account's inbox mail from the last 24 h. */
export async function inboxMails(account: string): Promise<InboxMail[] | Failed> {
  const dir = gwsDir(account);
  const params = JSON.stringify({ userId: "me", q: "in:inbox newer_than:1d", maxResults: INBOX_SUBJECTS_MAX });
  const listed = await runGws(["gmail", "users", "messages", "list", "--params", params], GWS_TIMEOUT_MS, { gwsProfileDir: dir });
  if (!listed.ok) return { error: `gws could not list ${account} mail: ${listed.error.slice(0, 160)}` };
  const ids = extractGwsMessageIds(listed.parsed);
  if (ids.length === 0) return [];
  const { messages, error } = await fetchGwsMessages(ids, INBOX_SUBJECTS_MAX, GWS_TIMEOUT_MS, dir);
  if (error && messages.length === 0) return { error: `gws could not read ${account} mail: ${error.slice(0, 160)}` };
  return messages
    .map((m) => ({ subject: m.subject ?? "", sender: m.sender }))
    .filter((m) => m.subject.trim().length > 0);
}

/** J2 truth: titles of today's events (one IST day) on the account's primary calendar. */
export async function calendarTitles(account: string, window: { start: string; end: string }): Promise<string[] | Failed> {
  const params = { calendarId: "primary", timeMin: window.start, timeMax: window.end, singleEvents: true, orderBy: "startTime", maxResults: 50 };
  const r = await runGws(["calendar", "events", "list", "--params", JSON.stringify(params)], GWS_TIMEOUT_MS, { gwsProfileDir: gwsDir(account) });
  if (!r.ok) return { error: `gws could not read the ${account} calendar: ${r.error.slice(0, 160)}` };
  const root = (r.parsed && typeof r.parsed === "object" ? r.parsed : {}) as Record<string, unknown>;
  const data = (root["data"] ?? root) as Record<string, unknown>;
  const items = Array.isArray(data["items"]) ? (data["items"] as Array<Record<string, unknown>>) : [];
  return items.map((i) => String(i["summary"] ?? "")).filter((t) => t.trim().length > 0);
}

async function github<T>(path: string): Promise<T> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN must be set");
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub ${path.split("?")[0]} answered ${res.status}`);
  return (await res.json()) as T;
}

/** J3 truth: open PRs with the same CI verdict the bot's list_prs gives (summarizeChecks). */
export async function openPrs(repo: string): Promise<OpenPr[]> {
  type Pr = { number: number; created_at: string; head: { sha: string } };
  type Runs = { check_runs: Array<{ name: string; status: string; conclusion: string | null }> };
  const prs = await github<Pr[]>(`/repos/${repo}/pulls?state=open&per_page=50`);
  return Promise.all(
    prs.map(async (p) => {
      const ci = await github<Runs>(`/repos/${repo}/commits/${p.head.sha}/check-runs?per_page=100`)
        .then((r) => summarizeChecks(r.check_runs).ci)
        .catch((err: unknown) => `unavailable: ${why(err)}`); // allow-failopen: an unreadable CI is scored as "unavailable", never as a colour
      return { number: p.number, ci, createdAt: p.created_at };
    }),
  );
}

/** J3: which PR numbers are open right now (one call, no CI reads): the bot's list moves while it answers. */
export async function openPrNumbers(repo: string): Promise<Set<number>> {
  const prs = await github<Array<{ number: number }>>(`/repos/${repo}/pulls?state=open&per_page=50`);
  return new Set(prs.map((p) => p.number));
}

/** Journey B truth: the same three GitHub search counts /where prints. */
export async function whereCounts(repo: string): Promise<WhereCounts> {
  const count = async (q: string) =>
    (await github<{ total_count: number }>(`/search/issues?per_page=1&q=${encodeURIComponent(q)}`)).total_count;
  const since = new Date(Date.now() - WEEK_MS).toISOString().replace(/\.\d+Z$/, "Z");
  const [done, openPrsN, left] = await Promise.all([
    count(`repo:${repo} is:pr is:merged merged:>=${since}`),
    count(`repo:${repo} is:pr is:open`),
    count(`repo:${repo} is:issue is:open`),
  ]);
  return { done, openPrs: openPrsN, left };
}

/** J5: the reminder row the ask created (matched on its text, made after the ask), and every scheduled reminder. */
export async function reminderRows(
  textLike: string,
  askedAt: string,
): Promise<{ created: { text: string; firedAt: string | null } | undefined; scheduled: string[] }> {
  const db = getDb();
  const made = await db.execute(sql`
    SELECT text, fired_at FROM agents.reminders
    WHERE created_at >= ${askedAt}::timestamptz AND text ILIKE ${`%${textLike}%`}
    ORDER BY created_at DESC LIMIT 1`);
  const row = made[0] as { text: string; fired_at: Date | string | null } | undefined;
  const sched = await db.execute(sql`SELECT text FROM agents.reminders WHERE status = 'scheduled' ORDER BY remind_at`);
  return {
    created: row ? { text: row.text, firedAt: row.fired_at === null ? null : new Date(row.fired_at).toISOString() } : undefined,
    scheduled: (sched as unknown as Array<{ text: string }>).map((r) => r.text),
  };
}

// ── health reads ────────────────────────────────────────────────────────────────────────────

export async function readOpenRouter(): Promise<HealthReads["openRouter"]> {
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) return { error: "OPENROUTER_API_KEY is not set" };
  try {
    const get = async (path: string) => {
      const res = await fetch(`https://openrouter.ai/api/v1/${path}`, { headers: { authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`/${path} answered HTTP ${res.status}`);
      return (await res.json()) as { data: Record<string, unknown> };
    };
    const [credits, keyInfo] = await Promise.all([get("credits"), get("key")]);
    const balanceUsd = Number(credits.data["total_credits"]) - Number(credits.data["total_usage"]);
    const remaining = keyInfo.data["limit_remaining"];
    return { balanceUsd, keyRemainingUsd: typeof remaining === "number" ? remaining : null };
  } catch (err) {
    return { error: why(err) };
  }
}

/** One generateContent call with a one-token answer: the cheapest proof the key still works. */
export async function readAiStudio(): Promise<HealthReads["aiStudio"]> {
  const key = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  if (!key) return { error: "GOOGLE_GENERATIVE_AI_API_KEY is not set" };
  const model = process.env["JOURNEY_AI_STUDIO_MODEL"] ?? "gemini-3.5-flash-lite";
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts: [{ text: "ok" }] }], generationConfig: { maxOutputTokens: 1 } }),
    });
    return { status: res.status, body: (await res.text()).slice(0, 2_000) };
  } catch (err) {
    return { error: why(err) };
  }
}

/** The coding pipeline's Claude login, as claude-agent with every API-key env removed (subscription only). */
export async function readClaude(): Promise<HealthReads["claude"]> {
  try {
    const { stdout, stderr } = await run("sudo", ["-n", "-u", "claude-agent", "--", "bash", "-lc", CLAUDE_PROBE_CMD], { timeout: 90_000 });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") return { error: `could not run claude as claude-agent: ${why(err)}` };
    return { exitCode: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Which mailbox each Google account really reads (#1031: "work" answered with personal mail). */
export async function readGoogle(): Promise<GoogleRead[]> {
  const params = JSON.stringify({ userId: "me" });
  return Promise.all(
    listGoogleMailboxes().map(async (account): Promise<GoogleRead> => {
      const dir = gwsDir(account);
      const ownLogin = existsSync(`${dir}/credentials.json`);
      const r = await runGws(["gmail", "users", "getProfile", "--params", params], GWS_TIMEOUT_MS, { gwsProfileDir: dir });
      if (!r.ok) return { account, ownLogin, error: gwsErrorLine(r.error) };
      const root = (r.parsed && typeof r.parsed === "object" ? r.parsed : {}) as Record<string, unknown>;
      const data = (root["data"] ?? root) as Record<string, unknown>;
      const email = typeof data["emailAddress"] === "string" ? data["emailAddress"] : undefined;
      return email ? { account, ownLogin, email } : { account, ownLogin };
    }),
  );
}

export async function readUnits(): Promise<HealthReads["units"]> {
  try {
    const failed = await run("systemctl", ["--failed", "--no-legend", "--plain"], { timeout: 15_000 });
    const names = failed.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0] ?? "")
      .filter((n) => n.length > 0);
    // is-active exits 3 for "inactive"/"failed": the answer is on stdout either way.
    const gateway = await run("systemctl", ["is-active", "founderos"], { timeout: 15_000 })
      .then((r) => r.stdout.trim())
      .catch((err: unknown) => ((err as { stdout?: string }).stdout ?? "").trim() || `unknown (${why(err)})`); // allow-failopen: the state string is printed and anything but "active" is red
    return { failed: names, gateway };
  } catch (err) {
    return { error: `systemctl: ${why(err)}` };
  }
}

/** ~/.claude/*.off: daemons switched off on purpose (pr-brain.off, agent-dispatch.off). */
export function readKillSwitches(home = process.env["HOME"] ?? ""): string[] {
  try {
    return readdirSync(`${home}/.claude`).filter((f) => f.endsWith(".off")).sort();
  } catch {
    return []; // allow-failopen: no ~/.claude folder means no kill switch is set
  }
}

export async function readSpend(window: { start: string; end: string }, capUsd: number): Promise<HealthReads["spend"]> {
  try {
    const r = await getDb().execute(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd FROM agents.ai_call_costs
      WHERE created_at >= ${window.start}::timestamptz AND created_at < ${window.end}::timestamptz`);
    return { yesterdayUsd: Number((r[0] as { usd: number | string }).usd), capUsd };
  } catch (err) {
    return { error: `could not read ai_call_costs: ${why(err)}` };
  }
}
