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
import { formatBackfillLine, formatNewRowsAlert } from "./sweep-heartbeat.js";
import type { PendingAlertRow, PendingAlerts } from "../../db/job-digest-schema.js";

const log = childLogger({ module: "scheduler" });

/** Local hours (app timezone) at which a batch may go out. Three a day, so at most three group messages. */
export const DIGEST_HOURS: readonly number[] = [9, 14, 19];

/** A batch names more roles than the old per-sweep alert, because it replaces several of them. */
export const DIGEST_NAMED = 8;

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

export interface DigestDeps {
  readonly profiles: readonly JobSearchProfile[];
  readonly tz?: string;
  readonly load: (profileIds: readonly string[]) => Promise<Map<string, DigestState>>;
  /** dedupeKey to short role id, for the roles the batch names. */
  readonly ids: (profile: JobSearchProfile, keys: readonly string[]) => Promise<Map<string, string>>;
  readonly send: (text: string) => Promise<void>;
  readonly mark: (profileId: string, at: Date) => Promise<void>;
}

async function realDeps(): Promise<DigestDeps> {
  const { listProfiles } = await import("./profile-config.js");
  const queries = await import("../../db/job-digest-queries.js");
  const { sendToJobsChat } = await import("../../infra/telegram-send.js");
  return {
    profiles: listProfiles(),
    load: async (profileIds) => {
      const stored = await queries.loadDigestStates(profileIds);
      return new Map([...stored].map(([id, s]) => [id, { pending: s.pending ?? EMPTY_PENDING, lastDigestAt: s.lastDigestAt }]));
    },
    ids: async (profile, keys) => {
      try {
        const { jobIdsByDedupeKey } = await import("../../db/job-ref-queries.js");
        return await jobIdsByDedupeKey([...keys], { tenantId: profile.tenantId, profileId: profile.id });
      } catch (err) {
        // allow-failopen: the batch is the deliverable and `/draft <id>` is the shortcut. A missing shortcut is
        // visible on the line; a guessed one would not be.
        log.warn({ err: (err as Error).message, profile: profile.id }, "Role ids unavailable for batch");
        return new Map();
      }
    },
    send: (text) => sendToJobsChat(text),
    mark: queries.markDigestSent,
  };
}

/** One candidate block of the batch: the same text the per-sweep alert used, now over everything buffered. */
async function sectionFor(profile: JobSearchProfile, pending: PendingAlerts, deps: DigestDeps): Promise<string> {
  const selector = profileSelector(profile);
  if (pending.rows.length === 0) return formatBackfillLine(pending.backfill, profile.candidateName, selector);
  const lines: IngestLine[] = pending.rows.map((r) => ({
    company: r.company,
    title: r.title,
    outcome: r.outcome,
    detail: "",
    isNew: true,
    url: r.url,
  }));
  const ids = await deps.ids(profile, pending.rows.slice(0, DIGEST_NAMED).map((r) => r.key));
  return formatNewRowsAlert(lines, null, profile.candidateName, {
    backfill: pending.backfill,
    ids,
    selector,
    named: DIGEST_NAMED,
    extra: pending.overflow,
  });
}

/**
 * Send the batch if a slot has started and anything is buffered. ONE message for every candidate that is due,
 * so two lanes do not double the count. Returns normally when there is nothing to send; throws when the send
 * fails, with every buffer left as it was.
 */
export async function sendDueDigest(now: Date, deps?: DigestDeps): Promise<void> {
  const d = deps ?? (await realDeps());
  const tz = d.tz ?? digestTimeZone();
  const states = await d.load(d.profiles.map((p) => p.id));
  const due = d.profiles
    .map((profile) => ({ profile, state: states.get(profile.id) ?? { pending: EMPTY_PENDING, lastDigestAt: null } }))
    .filter(({ state }) => state.pending.rows.length > 0 || state.pending.backfill > 0)
    .filter(({ state }) => digestDue(state.lastDigestAt, now, tz));
  if (due.length === 0) return;

  const sections: string[] = [];
  for (const { profile, state } of due) sections.push(await sectionFor(profile, state.pending, d));
  await d.send(sections.join("\n\n"));
  for (const { profile } of due) await d.mark(profile.id, now);
  log.info({ profiles: due.map((x) => x.profile.id) }, "Batched new-role alert sent");
}
