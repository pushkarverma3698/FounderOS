/**
 * FounderOS — which actionable section a row belongs in
 * =====================================================
 * Membership rules for the brief's three actionable sections, and the caps that
 * bound them. Split out of brief.ts on 2026-08-06 when a third section pushed
 * that file against the 400-line budget — the same reason brief-sections.ts and
 * brief-cv.ts exist.
 *
 * ONE PLACE DECIDES. `formatDailyBrief` renders these selections and
 * `persistBriefRanks` writes their indices to the database as `/draft N`'s
 * meaning. Both consume the SAME ordered array from the same pure function, so
 * the printed number and the pinned rank agree by construction. A second notion
 * of membership anywhere would drift silently into drafting for the wrong
 * company.
 *
 * THE SECTIONS ARE DISJOINT BY CONSTRUCTION, and they have to be: a row carries
 * exactly one `brief_section` in the table, so a row qualifying for two would
 * have one of its ranks overwritten and lose a command it was printed with.
 * DO TODAY takes passes; STRETCH and ASK split the flags between them.
 */

import { blockingGates } from "./gates.js";
import {
  allocateByMarket,
  PER_MARKET_ASK,
  PER_MARKET_DO_TODAY,
  PER_MARKET_STRETCH,
} from "./brief-sections.js";
import type { BriefRow } from "./brief-row.js";

/**
 * How many rows each actionable section prints IN FULL.
 *
 * Raised from 3 on 2026-08-01 (founder direction: "even if telegram message
 * doesn't give all the result in one message give in 2 or 3 messages so that we
 * can read everything and decide").
 *
 * Ten full rows across the two sections lands at roughly four Telegram messages.
 * The first attempt at this used ten PER section and produced nine messages
 * against the real table — which satisfies the letter of "show me everything"
 * and defeats the point of it: a wall of text nobody reads is the same outcome
 * as a brief that hid the row. The complaint that started this was never about
 * the cap; it was that the reasons were unreadable.
 *
 * When the cap bites the brief SAYS SO with the count. A silent truncation is
 * the failure this pipeline keeps being wrong about.
 */
export const DO_TODAY_CAP = 6;
export const ASK_CAP = 4;

/**
 * The stretch section's cap, matched to ASK_CAP rather than to DO_TODAY_CAP.
 *
 * These rows were REJECTS until 2026-08-06 and cost one audit line each; as
 * full rows they cost roughly as much space as an ASK row, and they are a
 * weaker bet than a row that cleared every check. Four keeps the third section
 * from taking more of the message than the section it is subordinate to, and
 * whatever it cannot show is stated as a number rather than dropped.
 */
export const STRETCH_CAP = 4;

/** The gate name the stretch band is defined against. Matched on name, never on prose. */
const EXPERIENCE_GATE = "Experience";

/**
 * DO TODAY: passed every gate AND confirmed still open.
 *
 * `unverifiable` does not qualify — but it does not disqualify the row from the
 * brief either; it lands in the ASK section with the reason stated. Silently
 * dropping a role because a network call failed is the failure direction this
 * pipeline exists to avoid.
 */
export function isDoTodayRow(row: BriefRow): boolean {
  return row.verdict === "pass" && row.liveness === "live";
}

/**
 * A STRETCH: every check cleared except the years, and the years are a wish.
 *
 * WHY THIS IS NOT AN ASK. Every other flag source — an absent sponsor entry, an
 * unstated salary, a Dutch requirement — is genuinely a question for the
 * employer, and `/ask` writes it. The years bar is the first flag where asking
 * is the WRONG action: "is the five years firm?" invites a pre-emptive rejection
 * on the exact gate the 2026-08-06 change argues is aspirational, and it
 * contradicts the gate's own evidence, which tells the founder to apply early.
 * So these rows carry `/draft`, and they are numbered as a continuation of DO
 * TODAY because that is the same act.
 *
 * A row flagged on the years AND on anything else stays in ASK: the other flag
 * IS a real question, and one message to an employer should settle the check
 * that a message can settle.
 *
 * Membership reads gate STATUS through `blockingGates`, never the evidence text.
 * Deriving a status from prose is the original defect this module's neighbours
 * were written to close (see gates.ts).
 */
export function isStretchRow(row: BriefRow): boolean {
  if (row.verdict !== "flag" || row.liveness === "expired") return false;
  const unresolved = blockingGates({ status: "flag", gates: row.gates });
  return unresolved.length > 0 && unresolved.every((g) => g.gate === EXPERIENCE_GATE);
}

/**
 * ONE QUESTION AWAY: a single unresolved gate stands between this and an
 * application, and the founder can settle it by asking the employer.
 *
 * A PASS whose liveness could not be confirmed belongs here too: it is one
 * check away from actionable, and that check is "is this still open?".
 *
 * Stretch rows are excluded — see `isStretchRow` for why asking about the years
 * is the wrong move.
 */
export function isAskableRow(row: BriefRow): boolean {
  if (row.liveness === "expired") return false;
  if (isStretchRow(row)) return false;
  return row.verdict === "flag" || (row.verdict === "pass" && row.liveness !== "live");
}

export function selectDoToday(rows: readonly BriefRow[]): BriefRow[] {
  return allocateByMarket(rows.filter(isDoTodayRow), PER_MARKET_DO_TODAY, DO_TODAY_CAP);
}

export function selectStretch(rows: readonly BriefRow[]): BriefRow[] {
  return allocateByMarket(rows.filter(isStretchRow), PER_MARKET_STRETCH, STRETCH_CAP);
}

export function selectAskable(rows: readonly BriefRow[]): BriefRow[] {
  return allocateByMarket(rows.filter(isAskableRow), PER_MARKET_ASK, ASK_CAP);
}
