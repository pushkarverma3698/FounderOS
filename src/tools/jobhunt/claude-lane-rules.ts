/**
 * Claude hand-off lane: the pure parts
 * ====================================
 * Hand-off rows the TS form runner cannot do (a multi-step wizard, a custom career site, "no fillable form fields") are
 * filled to the final Submit page by a Claude Code routine on the Mac. The founder approves in a Remote Control chat.
 *
 * The lane is DERIVED from `apply_lane` + `apply_lane_reason`, not stored: the stored value stays "hand_off" so the
 * queue, the digest and the scoreboard keep reading one value. It never overlaps the Mac TS worker's lane
 * (mac-worker-rules.ts: a CAPTCHA or bot check), and both lanes lease through the same `mac_lease_*` columns, so a row
 * can only ever be open in one of them.
 *
 * States, kept in `mac_result` (no migration): leased -> filled_to_submit -> submitted | failed. `filled_to_submit` is
 * never "applied": only a `submitted` report after it settles the row (apply-submit.ts, audit key `auditKeyFor`).
 */

import { isMacEligibleReason } from "./mac-worker-rules.js";

export const CLAUDE_LANE = "claude_hand_off";
export type ClaudeLane = typeof CLAUDE_LANE;

/** At most this many rows come back from one lease call (one run). */
export const CLAUDE_MAX_PER_LEASE = 10;
/** A filled tab is held for the founder's yes this long; the lease is pushed out to it so no other lane opens the row. */
export const CLAUDE_FILLED_HOLD_MS = 12 * 60 * 60 * 1000;
/** The longest link and blank-field list a filled report keeps. */
export const MAX_LINK_CHARS = 500;
export const MAX_BLANKS = 40;
export const MAX_BLANK_CHARS = 80;
export const CLAUDE_FILLED_PREFIX = "filled_to_submit:";

/**
 * Reasons a person fills by hand but Claude can: apply-lane.ts words them "Form not usable: <why>" (a wizard, a custom
 * site, no fillable fields) and "Workday: <why>". One source string for the SQL (`~*`) and `claudeLaneOf`.
 * Excluded: aggregators, LinkedIn (needs a login), links with no employer page, expired postings: nothing to fill.
 */
export const CLAUDE_REASON_PATTERN = "^Form not usable:";
export const CLAUDE_WORKDAY_PATTERN = "^Workday:";
export const CLAUDE_EXCLUDE_PATTERN = "aggregator|authenticated|no valid http|no employer|expired|no longer";

const CLAUDE_REASON_RE = new RegExp(CLAUDE_REASON_PATTERN, "i");
const CLAUDE_WORKDAY_RE = new RegExp(CLAUDE_WORKDAY_PATTERN, "i");
const CLAUDE_EXCLUDE_RE = new RegExp(CLAUDE_EXCLUDE_PATTERN, "i");

/** The SQL regex for the lease: the always-on reason, plus Workday only when `workday` is on. */
export const claudeReasonSql = (workday: boolean): string => (workday ? `${CLAUDE_REASON_PATTERN}|${CLAUDE_WORKDAY_PATTERN}` : CLAUDE_REASON_PATTERN);

export interface ClaudeLaneInput {
  readonly apply_lane: string | null;
  readonly apply_lane_reason: string | null;
}

/** `claude_hand_off` when Claude should fill this row, else null. Workday only with `workday` on (CLAUDE_LANE_WORKDAY=1). */
export function claudeLaneOf(row: ClaudeLaneInput, opts: { readonly workday: boolean }): ClaudeLane | null {
  if (row.apply_lane !== "hand_off") return null;
  const reason = row.apply_lane_reason ?? "";
  if (isMacEligibleReason(reason)) return null; // a bot check is the TS worker's: Claude never solves one
  if (opts.workday && CLAUDE_WORKDAY_RE.test(reason)) return CLAUDE_LANE;
  if (!CLAUDE_REASON_RE.test(reason)) return null;
  const cause = reason.replace(/^[^:]*:\s*/, "");
  return CLAUDE_EXCLUDE_RE.test(cause) ? null : CLAUDE_LANE;
}

export type ClaudeState = "leased" | "filled_to_submit";

/** Where a leased row stands, read from `mac_result`. An applied row is never "filled". */
export function claudeStateOf(row: { readonly mac_result: string | null; readonly applied_at?: Date | null }): ClaudeState {
  if (row.applied_at) return "leased";
  return (row.mac_result ?? "").startsWith(CLAUDE_FILLED_PREFIX) ? "filled_to_submit" : "leased";
}

export type ClaudeOutcome = "filled_to_submit" | "submitted" | "confirmed" | "failed" | "other";

/**
 * May this report be applied to a Claude-lane row? `submitted` only from `filled_to_submit` (so a row that was never
 * filled and shown to the founder cannot become applied), and the TS worker's `confirmed` is refused on this lane
 * because it would skip that step.
 */
export function transitionAllowed(state: ClaudeState, outcome: ClaudeOutcome): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  if (outcome === "submitted" && state !== "filled_to_submit") return { ok: false, error: "submitted needs a filled_to_submit report first" };
  if (outcome === "confirmed") return { ok: false, error: "this row is in the Claude lane: report filled_to_submit, then submitted" };
  return { ok: true };
}

export interface FilledReport {
  readonly link: string;
  readonly blanks: readonly string[];
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The `mac_result` text for a filled tab: prefix + JSON of the link and the blank field labels (clipped). */
export function formatFilledResult(report: FilledReport): string {
  const blanks = report.blanks.map((b) => clip(b.trim(), MAX_BLANK_CHARS)).filter((b) => b.length > 0).slice(0, MAX_BLANKS);
  return `${CLAUDE_FILLED_PREFIX}${JSON.stringify({ link: clip(report.link.trim(), MAX_LINK_CHARS), blanks })}`;
}

/** The inverse of `formatFilledResult`; null when `mac_result` is not a filled report. A damaged one shows as no link. */
export function parseFilledResult(macResult: string | null | undefined): FilledReport | null {
  if (!macResult?.startsWith(CLAUDE_FILLED_PREFIX)) return null;
  try {
    const raw = JSON.parse(macResult.slice(CLAUDE_FILLED_PREFIX.length)) as { link?: unknown; blanks?: unknown };
    const blanks = Array.isArray(raw.blanks) ? raw.blanks.filter((b): b is string => typeof b === "string") : [];
    return { link: typeof raw.link === "string" ? raw.link : "", blanks };
  } catch {
    // allow-failopen: a damaged report is shown as a tab with no link rather than hiding the filled row.
    return { link: "", blanks: [] };
  }
}

export interface ClaudeFilledRow {
  readonly rowId: string;
  readonly company: string;
  readonly title: string;
  readonly link: string;
  readonly blanks: readonly string[];
  readonly filledAt: Date | null;
}

export interface ClaudeFilledSource {
  readonly id: string;
  readonly company: string;
  readonly title: string;
  readonly mac_result: string | null;
  readonly mac_result_at: Date | null;
  readonly applied_at: Date | null;
}

/** The filled-and-waiting rows, oldest first: what the apply queue page lists as "Claude filled, waiting for your yes". */
export function claudeFilledRows(rows: readonly ClaudeFilledSource[]): ClaudeFilledRow[] {
  const out: ClaudeFilledRow[] = [];
  for (const r of rows) {
    if (claudeStateOf(r) !== "filled_to_submit") continue;
    const report = parseFilledResult(r.mac_result);
    if (!report) continue;
    out.push({ rowId: r.id, company: r.company, title: r.title, link: report.link, blanks: report.blanks, filledAt: r.mac_result_at });
  }
  return out.sort((a, b) => (a.filledAt?.getTime() ?? 0) - (b.filledAt?.getTime() ?? 0));
}

const MESSAGE_LIMIT = 3500;
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function entryLine(n: number, r: ClaudeFilledRow): string {
  const blanks = r.blanks.length > 0 ? `Left blank: ${r.blanks.map(esc).join("; ")}` : "Nothing left blank";
  const link = r.link ? `\n${esc(r.link)}` : "";
  return `${n}. <b>${esc(r.company)}</b> (${esc(r.title)})${link}\n${blanks}`;
}

/**
 * One run's Telegram text: every filled tab with its number, job, company, link and blanks. Split at tab boundaries into
 * messages of at most `limit` characters (a tab is never cut in half; one too long is shortened). Empty when none.
 */
export function formatFilledMessages(rows: readonly ClaudeFilledRow[], limit: number = MESSAGE_LIMIT): string[] {
  if (rows.length === 0) return [];
  const head = `<b>Claude filled ${rows.length} form${rows.length === 1 ? "" : "s"} to the Submit page.</b> Nothing is sent. Reply in the Remote Control chat, e.g. "submit 1, 3".`;
  const chunks: string[] = [];
  let current = head;
  rows.forEach((r, i) => {
    let line = entryLine(i + 1, r);
    if (line.length > limit - 20) line = `${line.slice(0, limit - 40)}…`;
    if (current.length + line.length + 2 > limit) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${line}` : line;
  });
  chunks.push(current);
  return chunks.length === 1 ? chunks : chunks.map((c, i) => `${c}\n\n(${i + 1}/${chunks.length})`);
}
