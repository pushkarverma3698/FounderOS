/**
 * FounderOS — the one-message brief
 * =================================
 * `/jobs` and `/today` used to send the whole brief: a header, every section,
 * the reject lists, spend, a legend, six or more messages. On a phone that is a
 * wall, and prod showed what a wall does: 4,307 screened rows, 2 applications.
 *
 * Now they send ONE message under 1,500 characters: the top three roles to apply
 * to today, a 📝 Draft button each, then "Show more" (the full brief, rebuilt) and
 * "CSV" (the whole queue as a file). Nothing is removed, it is one tap away.
 *
 * Applies only to a plain `/jobs` or `/today`. A range or axis ("/jobs 7d")
 * asks for the long view and gets it; `/fresh` is a delta list and is untouched.
 * When no role is ready the full brief is sent instead, because it is the thing
 * that says WHY the queue is empty.
 */

import { InlineKeyboard, type Context } from "grammy";
import { draftKeyboard } from "./jobhunt-buttons.js";
import { listApplyQueue } from "../db/apply-queries.js";
import { parseBriefRequest, type BriefVerb } from "../tools/jobhunt/brief-resolver.js";
import type { JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import type { JobApplication } from "../db/schema.js";
import { childLogger } from "../infra/logger.js";
import { safeHtml } from "./approval-card.js";

const log = childLogger({ module: "gateway:jobhunt-compact" });

/** Telegram allows 4,096; the audit's budget for the brief is 1,500. */
export const COMPACT_MAX_CHARS = 1500;
/** How many roles the one-message brief shows. */
export const COMPACT_ROLE_COUNT = 3;
/** How many 📝 Draft buttons a brief carries. */
export const DRAFT_BUTTON_COUNT = 3;

export type CompactRole = Pick<JobApplication, "id" | "company" | "title" | "url">;
export interface CompactLookup {
  readonly roles: readonly CompactRole[];
  /** Everything ready to apply to, not just what is shown. */
  readonly total: number;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The message text. Pure. Titles shrink until it fits; the roles themselves are never dropped. */
export function renderCompact(roles: readonly CompactRole[], total: number, whose: string): string {
  for (const titleMax of [90, 60, 40, 24]) {
    const lines = roles.flatMap((r, i) => [
      `${i + 1}. <b>${safeHtml(clip(r.company, 40))}</b> — ${safeHtml(clip(r.title, titleMax))}`,
      ...(r.url && /^https?:\/\//i.test(r.url) ? [`   <a href="${safeHtml(r.url)}">posting</a>`] : []),
    ]);
    const text =
      `📋 <b>Top ${roles.length} to apply to today</b> — ${whose} queue (${total} ready)\n\n` +
      `${lines.join("\n")}\n\n` +
      `Tap 📝 Draft to tailor the CV. ➕ Show more has all ${total} with the reasons.`;
    if (text.length <= COMPACT_MAX_CHARS) return text;
  }
  // A URL can still be long; drop the links before dropping a role.
  return (
    `📋 <b>Top ${roles.length} to apply to today</b> — ${whose} queue (${total} ready)\n\n` +
    roles.map((r, i) => `${i + 1}. <b>${safeHtml(clip(r.company, 40))}</b> — ${safeHtml(clip(r.title, 24))}`).join("\n")
  ).slice(0, COMPACT_MAX_CHARS);
}

const VIEW_PREFIX = "jh:";
type ViewVerb = Exclude<BriefVerb, "fresh">;

/** Draft button per role, then one row: ➕ Show more, 📎 CSV. */
export function compactKeyboard(roles: readonly CompactRole[], verb: ViewVerb, profileId: string): InlineKeyboard {
  return draftKeyboard(roles)
    .text("➕ Show more", `${VIEW_PREFIX}m:${verb}:${profileId}`)
    .text("📎 CSV", `${VIEW_PREFIX}c:${profileId}`);
}

export type ViewCallback =
  | { kind: "more"; verb: ViewVerb; profileId: string }
  | { kind: "csv"; profileId: string };

/** Parse a ➕ / 📎 tap; null for anything that is not ours. Draft taps (`jh:d:`) are not ours. */
export function parseViewCallback(data: string): ViewCallback | null {
  const [kind, a, b] = data.startsWith(VIEW_PREFIX) ? data.slice(VIEW_PREFIX.length).split(":") : [];
  if (kind === "m" && (a === "jobs" || a === "today") && b) return { kind: "more", verb: a, profileId: b };
  if (kind === "c" && a) return { kind: "csv", profileId: a };
  return null;
}

/** True when the request carries nothing but, at most, a profile name. */
export function isPlainRequest(raw: string, verb: BriefVerb): boolean {
  const asked = parseBriefRequest(raw, verb);
  const bare = parseBriefRequest("", verb);
  return !("unknown" in asked) && "windowHours" in bare && asked.windowHours === bare.windowHours && asked.axis === bare.axis;
}

/** Ready-to-apply roles for a profile, best rank first. */
export async function topRolesFor(profile: JobSearchProfile): Promise<CompactLookup> {
  const ready = (await listApplyQueue(profile.tenantId, profile.id)).filter((r) => r.brief_section === "do_today");
  return { roles: ready.slice(0, COMPACT_ROLE_COUNT), total: ready.length };
}

/**
 * Send the one-message brief. True when sent; false when the caller should send
 * the full brief instead (nothing ready, or the lookup failed).
 */
export async function sendCompactBrief(
  ctx: Context,
  profile: JobSearchProfile,
  verb: ViewVerb,
  explicitProfile: boolean,
  lookup: (profile: JobSearchProfile) => Promise<CompactLookup>,
): Promise<boolean> {
  try {
    const { roles, total } = await lookup(profile);
    if (roles.length === 0) return false;
    await ctx.reply(renderCompact(roles, total, explicitProfile ? `${profile.candidateName}'s` : "your"), {
      parse_mode: "HTML",
      reply_markup: compactKeyboard(roles, verb, profile.id),
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (err) {
    // allow-failopen: the compact card is the convenience; the full brief is the deliverable.
    log.warn({ err: (err as Error).message }, "Compact brief not sent — falling back to the full brief");
    return false;
  }
}

/** Top queued roles that appear in the rendered brief, as a keyboard; null when none do. */
export async function draftButtonsFor(profile: JobSearchProfile, brief: string): Promise<InlineKeyboard | null> {
  try {
    const queue = await listApplyQueue(profile.tenantId, profile.id);
    const shown = queue.filter((r) => brief.includes(safeHtml(r.company))).slice(0, DRAFT_BUTTON_COUNT);
    return shown.length > 0 ? draftKeyboard(shown) : null;
  } catch (err) {
    // allow-failopen: buttons are a convenience on top of a brief that already rendered.
    log.warn({ err: (err as Error).message }, "Draft buttons not built");
    return null;
  }
}
