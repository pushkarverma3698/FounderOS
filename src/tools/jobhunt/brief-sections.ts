/**
 * FounderOS — the brief's market blocks
 * =====================================
 * The campaign runs in two markets since 2026-08-01 ("we need dutch and indian
 * both"), and they cannot share one ranking.
 *
 * WHY NOT ONE MERGED LIST. An Indian role clears more gates by construction —
 * no recognised-sponsor lookup, no IND salary criterion, no Dutch-language bar —
 * so on any status-ordered list every Indian row outranks every Dutch one. The
 * merged brief would not be "the best roles first"; it would be "the roles with
 * the fewest legal obstacles first", which is the same list every day and buries
 * the market the relocation actually depends on. The founder chose Netherlands
 * first, India second, each with its own actionable block.
 *
 * WHY THE NUMBERING LIVES HERE. `/draft 4` has to resolve to the row the founder
 * is looking at, and `persistBriefRanks` writes those numbers to the database
 * before the message is sent. So there is exactly ONE ordered array — the output
 * of `selectDoToday` / `selectAskable` — and both the renderer and the persister
 * consume it. The blocks are slices of that array with their global index kept,
 * never independently numbered lists. Two lists that number themselves would
 * drift the moment one market had a different number of rows, and the failure
 * would be silent: a draft written for the wrong company.
 *
 * Pure formatting. No DB, no network, no model.
 */

import { esc } from "./telegram-format.js";
import { renderRow, trimToSentence, type BriefRow } from "./brief-row.js";
import type { PostingCountry } from "./country.js";

/** What the market asked for, accumulated across passing screens. */
export interface TrendRow {
  readonly track: string;
  readonly sampleSize: number;
  readonly term: string;
  readonly seenCount: number;
  /** Days this term has been in demand and absent from that track's CV. */
  readonly absentDays: number | null;
}

/** What the day's feed calls cost and what they bought. Printed, never buried. */
export interface SpendLine {
  readonly runs: number;
  readonly returned: number;
  readonly costUsd: number;
  readonly failed: number;
  /**
   * Postings the tracker had never seen. The only number here that says whether
   * the money bought anything — `returned` is what we were BILLED for.
   */
  readonly fresh: number;
}

function pluralDays(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** "1 role" / "3 roles". "role(s)" is the tell of a template that never learned to count. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Which block a row belongs in.
 *
 * `unplaced` is the residual and it is NOT a synonym for "probably Dutch". It
 * holds rows whose country the feed never established, and rows we know sit in a
 * third country entirely. Folding either into the Netherlands block would assert
 * a market nobody confirmed — the exact move that put a Bogotá role into APPLY
 * TODAY on a Dutch partner permit.
 */
export type Market = "netherlands" | "india" | "unplaced";

export function marketOf(country: PostingCountry): Market {
  if (country === "NL") return "netherlands";
  if (country === "IN") return "india";
  return "unplaced";
}

/** Netherlands first — the founder's call, and the market the relocation needs. */
export const MARKET_ORDER: readonly Market[] = ["netherlands", "india", "unplaced"];

const MARKET_HEADING: Record<Market, string> = {
  netherlands: "🇳🇱 NETHERLANDS",
  india: "🇮🇳 INDIA",
  unplaced: "📍 LOCATION NOT CONFIRMED",
};

const MARKET_NOTE: Record<Market, string> = {
  netherlands: "Relocation roles. A permit basis has to carry each one.",
  india: "Local hires where you already live. No permit, no sponsor, no salary criterion.",
  unplaced:
    "The ad never said where these sit, or they sit somewhere that is neither market. " +
    "Each one's Location check says which.",
};

/**
 * How many rows each market is GUARANTEED in an actionable section.
 *
 * A reservation, not a quota: unused slots spill to the other markets below, so
 * a thin Dutch day still fills the brief. Without the reservation a run with
 * eight Dutch passes would push India out of the message entirely, and a market
 * that never appears is indistinguishable from a market with nothing in it.
 */
export const PER_MARKET_DO_TODAY = 3;
export const PER_MARKET_ASK = 2;

/**
 * Take up to `perMarket` from each market in order, then spill the remainder.
 *
 * The spill pass is what keeps the brief full. The reservation is what keeps it
 * honest about both markets.
 */
export function allocateByMarket(
  rows: readonly BriefRow[],
  perMarket: number,
  total: number,
): BriefRow[] {
  const byMarket = (m: Market): BriefRow[] => rows.filter((r) => marketOf(r.country) === m);

  const reserved = MARKET_ORDER.flatMap((m) => byMarket(m).slice(0, perMarket));
  if (reserved.length >= total) return reserved.slice(0, total);

  const taken = new Set(reserved.map((r) => r.id));
  const spill = MARKET_ORDER.flatMap((m) => byMarket(m)).filter((r) => !taken.has(r.id));
  return [...reserved, ...spill].slice(0, total);
}

/**
 * Render one ordered selection as market blocks.
 *
 * `startIndex` is the position of `selected[0]` in the founder's numbering, so
 * the ask section can continue from wherever the do-today section stopped when a
 * caller wants that. Each row's printed number is its index in `selected` — the
 * same array `persistBriefRanks` writes — which is what makes `/draft 4` and
 * "the fourth row of the message" the same thing by construction rather than by
 * two functions agreeing.
 */
export function renderMarketBlocks(
  selected: readonly BriefRow[],
  command: string,
  startIndex = 1,
): string {
  const blocks = MARKET_ORDER.flatMap((market) => {
    const rows = selected
      .map((row, i) => ({ row, index: i + startIndex }))
      .filter(({ row }) => marketOf(row.country) === market);
    if (rows.length === 0) return [];

    return [
      `<b>${MARKET_HEADING[market]} (${rows.length})</b>\n` +
        `<i>${esc(MARKET_NOTE[market])}</i>\n\n` +
        rows.map(({ row, index }) => renderRow(row, index, command)).join("\n\n"),
    ];
  });

  return blocks.join("\n\n");
}

/**
 * What the feeds filtered out on purpose, with counts.
 *
 * DELIBERATELY NOT under the "incomplete run" heading. Expired listings and
 * repeat rows are a feed working correctly, and printing them as failures would
 * make a healthy day read as a broken one — the mirror of the bug this section
 * exists to fix, where eight rows left through unreported code paths and "the
 * market is thin" was indistinguishable from "the mapper broke".
 */
export function renderFilterNotes(notes: readonly string[]): string {
  if (notes.length === 0) return "";
  return (
    `<b>🧹 WHAT THE FEEDS FILTERED</b>\n` +
    notes.map((n) => `• ${esc(n)}`).join("\n") +
    `\n<i>Working as intended — listed so a quiet market and a broken feed never ` +
    `look the same.</i>`
  );
}

/** True when the row was rejected on the level bar rather than on a legal one. */
export function isTooSenior(row: BriefRow): boolean {
  return row.gates.some((g) => g.gate === "Experience" && g.status === "reject");
}


/**
 * A rejected row, in one line.
 *
 * Deliberately terser than an actionable row. These are AUDIT material — the
 * founder asked for them so nothing is thrown away behind his back, not so he
 * could weigh them. The full evidence is on the record in `job_applications`;
 * what belongs on screen is which company, which role, and the bar that stopped
 * it. Printing the whole sentence for eighteen of them pushed the brief past ten
 * Telegram messages and buried the ten roles he can actually act on.
 */
const REJECT_REASON_MAX = 90;

export function renderRejectLine(row: BriefRow): string {
  const blocking = row.gates.find((g) => g.status === "reject") ?? row.gates[0];
  const reason = blocking
    ? `${blocking.gate}: ${trimToSentence(blocking.evidence, REJECT_REASON_MAX)}`
    : "no reason recorded";
  return `• <b>${esc(row.company)}</b> — ${esc(row.title)}\n    <i>${esc(reason)}</i>`;
}


/** What the market asked for, as a count rather than a ratio the data can't support. */
export function renderTrends(trends: readonly TrendRow[]): string {
  return (
    `<b>📈 WHAT THE MARKET ASKED</b>\n` +
    trends
      .map((t) => {
        const absence =
          t.absentDays !== null
            ? ` — missing from your ${esc(t.track)} CV for ${pluralDays(t.absentDays)}`
            : "";
        // Deliberately a COUNT, not a percentage. `seenCount` is an all-time
        // tally incremented on every passing screen; `sampleSize` counts the
        // distinct rows standing today. Dividing them printed "150%" live on
        // 2026-07-31 — a figure the stored data cannot support.
        const times = t.seenCount === 1 ? "once" : `${t.seenCount}×`;
        return (
          `• <b>${esc(t.term)}</b> <i>(${esc(t.track)})</i> — asked ${times} ` +
          `across ${plural(t.sampleSize, "role", "roles")} that cleared the gates${absence}`
        );
      })
      .join("\n")
  );
}

/**
 * What today cost.
 *
 * Printed in the brief rather than left in a table, because a cost nobody sees
 * is a cost nobody governs — and until 2026-08-01 the only way to answer "what
 * does this cost" was arithmetic by hand over the actor pricing pages.
 */
export function renderSpend(spend: SpendLine): string {
  const failed =
    spend.failed > 0
      ? ` <b>${spend.failed} of them failed</b> and were still billed for starting.`
      : "";
  // A SWEEP THAT BOUGHT NOTHING NEW MUST NOT READ AS A NORMAL MORNING. On
  // 2026-08-02 the sweep returned 32 postings for $0.4682 and every one was
  // already stored; the line said "for 32 postings" and looked like any other
  // day. The feed bills per job returned, so `returned` is the invoice and
  // `fresh` is the only part of it that was worth paying for — and a zero
  // stated as a bare digit is exactly the kind of quiet that has cost this
  // pipeline weeks before.
  const yielded =
    spend.fresh === 0
      ? ` <b>None of them new</b> — every posting was already in your list, ` +
        `so today's fetch bought nothing the pipeline did not already have.`
      : ` <b>${spend.fresh} new</b>, the rest already in your list.`;
  return (
    `<b>💰 WHAT TODAY COST</b>\n` +
    `$${spend.costUsd.toFixed(2)} across ${plural(spend.runs, "feed call", "feed calls")}, ` +
    `for ${plural(spend.returned, "posting", "postings")}.${yielded}${failed}\n` +
    `<i>Estimated from the actors' posted per-job prices, not from an invoice.</i>`
  );
}

