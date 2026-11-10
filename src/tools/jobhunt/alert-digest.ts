/**
 * FounderOS - new-role alerts, batched three a day
 * ===============================================
 * The free lane sweeps 48 times a day. Until 2026-10-05 every sweep that found a role sent its own message to
 * the family jobs group, so the group was a ticker and the one message that mattered looked like the rest.
 *
 * Now a sweep BUFFERS what it found (`bufferAlerts`, job_digest_state) and a batch goes out at three fixed
 * times a day (`DIGEST_HOURS`, in the app timezone). The number of group messages a day is a property of the
 * slot list, not of how busy the market was: at most three, because both candidates share ONE message.
 *
 * SEND FIRST, CLEAR ON SUCCESS. The buffer is emptied only after Telegram accepted the message. A failed send
 * leaves it intact and the next sweep (30 minutes later, still inside the slot) tries again.
 *
 * Which slot a moment falls in is decided by the LOCAL date and hour alone (`digestSlotKey`), so there is no
 * time-zone arithmetic to get wrong around a daylight-saving change, and a batch is due when the slot of now is
 * not the slot of the last batch.
 */

import { childLogger } from "../../infra/logger.js";
import { dedupeKey } from "./filters.js";
import type { IngestLine } from "./ingest-batch.js";
import { profileSelector, type JobSearchProfile } from "./profile-config.js";
import type { PendingAlertRow, PendingAlerts } from "../../db/job-digest-schema.js";
import { buildPersonMessages, type ApplyStats, type DigestMessage, type DigestRole } from "./digest-format.js";

const log = childLogger({ module: "scheduler" });

/** Local hours (app timezone) at which a batch may go out. Three a day, so at most three group messages. */
export const DIGEST_HOURS: readonly number[] = [9, 14, 19];

/** Roles kept per candidate between batches; past this they are counted in `overflow`, never dropped silently. */
export const PENDING_CAP = 50;

export const EMPTY_PENDING: PendingAlerts = { rows: [], backfill: 0, overflow: 0 };

export interface DigestState {
  readonly pending: PendingAlerts;
  readonly lastDigestAt: Date | null;
}

/** The founder-facing zone. Read from the environment like src/core/config.ts does (same name and default); that file is at its line budget. */
export function digestTimeZone(): string {
  return process.env["APP_TIMEZONE"]?.trim() || "Asia/Kolkata";
}

/** Local calendar date and hour of an instant in a zone. */
function localParts(at: Date, tz: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return { date: get("year") + "-" + get("month") + "-" + get("day"), hour: Number(get("hour")) };
}

/** `YYYY-MM-DD#k`: the local day and how many of the day slots have started (0 before the first). */
export function digestSlotKey(at: Date, tz: string = digestTimeZone()): string {
  const { date, hour } = localParts(at, tz);
  return date + "#" + DIGEST_HOURS.filter((h) => h <= hour).length;
}

/**
 * Is a batch due: at least one slot has started today, and it is not the slot the last batch went out in.
 * Before the first slot of the day the answer is no, so a buffer waits overnight for 09:00.
 */
export function digestDue(lastDigestAt: Date | null, now: Date, tz: string = digestTimeZone()): boolean {
  if (digestSlotKey(now, tz).endsWith("#0")) return false;
  return lastDigestAt === null || digestSlotKey(lastDigestAt, tz) !== digestSlotKey(now, tz);
}

/**
 * Add a sweep finds to a buffer. The same role is never listed twice (a re-screen of a stored row must not
 * double it), and roles past the cap are counted in `overflow`.
 */
export function mergePending(prev: PendingAlerts, rows: readonly PendingAlertRow[], backfill: number): PendingAlerts {
  const seen = new Set(prev.rows.map((r) => r.key));
  const kept = [...prev.rows];
  let overflow = prev.overflow;
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    if (kept.length < PENDING_CAP) kept.push(row);
    else overflow += 1;
  }
  return { rows: kept, backfill: prev.backfill + backfill, overflow };
}

/** Buffer one candidate sweep result for the next batch. Throws when the buffer cannot be written: the caller must not record the sweep as announced. */
export async function bufferAlerts(profileId: string, fresh: readonly IngestLine[], backfill: number): Promise<void> {
  if (fresh.length === 0 && backfill === 0) return;
  const queries = await import("../../db/job-digest-queries.js");
  const stored = (await queries.loadDigestStates([profileId])).get(profileId);
  const rows = fresh.map((line): PendingAlertRow => ({
    company: line.company,
    title: line.title,
    outcome: line.outcome === "pass" ? "pass" : "flag",
    url: line.url ?? null,
    key: dedupeKey(line.company, line.title),
  }));
  await queries.savePendingAlerts(profileId, mergePending(stored?.pending ?? EMPTY_PENDING, rows, backfill));
}

/** Inline keyboard rows, in the shape Telegram's Bot API takes. */
export type DigestKeyboard = readonly (readonly { readonly text: string; readonly callback_data: string }[])[];

/** A stored row for a buffered role: what a button needs, plus what ranks it. */
export interface DigestRowRef {
  readonly key: string;
  readonly id: string;
  readonly company: string;
  readonly section?: string | null;
  readonly fit?: string | number | null;
}

export interface DigestDeps {
  readonly profiles: readonly JobSearchProfile[];
  readonly tz?: string;
  readonly load: (profileIds: readonly string[]) => Promise<Map<string, DigestState>>;
  /** dedupeKey to the stored row, looked up under THIS profile only. Fails soft: the batch goes out without buttons. */
  readonly rows: (profile: JobSearchProfile, keys: readonly string[]) => Promise<readonly DigestRowRef[]>;
  /** Applied this week and open do-today roles, from the database. Optional; the nudge line is left out without it. */
  readonly stats?: (profile: JobSearchProfile, now: Date) => Promise<ApplyStats>;
  readonly send: (text: string, keyboard?: DigestKeyboard) => Promise<void>;
  readonly mark: (profileId: string, at: Date) => Promise<void>;
}

async function realDeps(): Promise<DigestDeps> {
  const { listProfiles } = await import("./profile-config.js");
  const queries = await import("../../db/job-digest-queries.js");
  const { sendToJobsChat } = await import("../../infra/telegram-send.js");
  const { jobRowsByDedupeKey } = await import("../../db/job-ref-queries.js");
  const { applyStatsFor } = await import("../../db/job-apply-stats.js");
  return {
    profiles: listProfiles(),
    load: async (profileIds) => {
      const stored = await queries.loadDigestStates(profileIds);
      return new Map([...stored].map(([id, s]) => [id, { pending: s.pending ?? EMPTY_PENDING, lastDigestAt: s.lastDigestAt }]));
    },
    rows: (profile, keys) => jobRowsByDedupeKey([...keys], { tenantId: profile.tenantId, profileId: profile.id }),
    stats: (profile, now) => applyStatsFor(profile.id, profile.tenantId, now),
    send: (text, keyboard) => sendToJobsChat(text, "HTML", keyboard),
    mark: queries.markDigestSent,
  };
}

/** Join the buffered roles to their stored rows. A failed lookup costs the buttons and the `/draft` ids, never the batch. */
async function rolesFor(profile: JobSearchProfile, pending: PendingAlerts, deps: DigestDeps): Promise<DigestRole[]> {
  let byKey = new Map<string, DigestRowRef>();
  try {
    byKey = new Map((await deps.rows(profile, pending.rows.map((r) => r.key))).map((r) => [r.key, r]));
  } catch (err) {
    // allow-failopen: the batch is the deliverable; without the lookup the roles are still named with their links.
    log.warn({ err: (err as Error).message, profile: profile.id }, "Row lookup failed for batch; sending without buttons");
  }
  return pending.rows.map((r) => {
    const hit = byKey.get(r.key);
    const fit = hit?.fit === undefined || hit.fit === null ? null : Number(hit.fit);
    return {
      key: r.key,
      company: r.company,
      title: r.title,
      url: r.url,
      outcome: r.outcome,
      rowId: hit?.id ?? null,
      section: hit?.section ?? null,
      fit: fit !== null && Number.isFinite(fit) ? fit : null,
    };
  });
}

async function statsFor(profile: JobSearchProfile, now: Date, deps: DigestDeps): Promise<ApplyStats | null> {
  if (!deps.stats) return null;
  try {
    return await deps.stats(profile, now);
  } catch (err) {
    // allow-failopen: the nudge is an extra line; the roles matter more than the count.
    log.warn({ err: (err as Error).message, profile: profile.id }, "Apply stats unavailable for batch");
    return null;
  }
}

/** One candidate's messages: the same roles the buffer holds, now every one named. */
async function messagesFor(profile: JobSearchProfile, pending: PendingAlerts, now: Date, deps: DigestDeps): Promise<DigestMessage[]> {
  return buildPersonMessages({
    name: profile.candidateName.trim().split(/\s+/)[0] ?? profile.candidateName,
    selector: profileSelector(profile),
    roles: pending.rows.length > 0 ? await rolesFor(profile, pending, deps) : [],
    overflow: pending.overflow,
    backfill: pending.backfill,
    stats: await statsFor(profile, now, deps),
  });
}

/**
 * Send the batch if a slot has started and anything is buffered: each due candidate gets her or his own
 * messages, so a button never sits under the other person's roles. SEND FIRST, CLEAR ON SUCCESS, per candidate:
 * a candidate's buffer is cleared only after all of that candidate's messages were accepted. Returns normally
 * when there is nothing to send; throws when a send fails, leaving that candidate's buffer as it was.
 */
export async function sendDueDigest(now: Date, deps?: DigestDeps): Promise<void> {
  const d = deps ?? (await realDeps());
  const tz = d.tz ?? digestTimeZone();
  const states = await d.load(d.profiles.map((p) => p.id));
  const due = d.profiles
    .map((profile) => ({ profile, state: states.get(profile.id) ?? { pending: EMPTY_PENDING, lastDigestAt: null } }))
    .filter(({ state }) => state.pending.rows.length > 0 || state.pending.backfill > 0)
    .filter(({ state }) => digestDue(state.lastDigestAt, now, tz));
  for (const { profile, state } of due) {
    for (const m of await messagesFor(profile, state.pending, now, d)) await d.send(m.text, m.keyboard);
    await d.mark(profile.id, now);
  }
  if (due.length > 0) log.info({ profiles: due.map((x) => x.profile.id) }, "Batched new-role alert sent");
}
