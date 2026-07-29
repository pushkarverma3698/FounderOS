/**
 * IND recognised-sponsor register loader
 * ======================================
 * Reads the scraped register (`docs/strategy/data/ind-sponsors-work.csv`,
 * produced by `scripts/ind-sponsors.ts`) and builds the lookup index that
 * `matchSponsor` screens against.
 *
 * The index is built ONCE per process and cached. It is ~12.9k entries and the
 * screening gate runs on every posting in a daily sweep, so re-reading the file
 * per call would dominate the cost of a screen that is otherwise pure string work.
 *
 * A missing or unreadable register is a LOUD failure, never an empty index:
 * screening every company against an empty register would mark the entire market
 * `not-sponsor` and silently reject everything — the exact failure mode the
 * three-way verdict in sponsor-match.ts exists to prevent.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildSponsorIndex, type SponsorIndex } from "./sponsor-match.js";

/** Repo root: src/tools/jobhunt/… and dist/tools/jobhunt/… are both three deep. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const SPONSOR_REGISTER_PATH = resolve(
  REPO_ROOT,
  "docs/strategy/data/ind-sponsors-work.csv",
);

/**
 * Parse one CSV line into fields, honouring quoted fields (register names contain
 * commas) and doubled quotes as an escaped quote. Small and local on purpose —
 * a two-column file does not justify a dependency.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

/** Extract the `name` column from the register CSV text. */
export function parseSponsorCsv(csv: string): string[] {
  const lines = csv
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return [];

  // Drop the header row only if it actually is one.
  const body = lines[0]!.startsWith("name,") ? lines.slice(1) : lines;
  return body.map((line) => parseCsvLine(line)[0] ?? "").filter((n) => n.length > 0);
}

/** Read the `# scraped: YYYY-MM-DD` stamp the scraper writes, if present. */
export function parseScrapedAt(csv: string): Date | null {
  const m = /^#\s*scraped:\s*(\d{4}-\d{2}-\d{2})/im.exec(csv);
  if (!m) return null;
  const d = new Date(`${m[1]!}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * How long the register may go unrefreshed before its answers stop being
 * trustworthy. IND republishes monthly, so 35 days is one cycle plus slack.
 */
export const REGISTER_MAX_AGE_DAYS = 35;

export interface RegisterStaleness {
  readonly stale: boolean;
  readonly ageDays: number | null;
  readonly note: string;
}

/**
 * Whether the register is too old to support a confident NEGATIVE.
 *
 * The asymmetry is the whole point. A stale register cannot invent a sponsor, so
 * a positive match stays valid however old the file is. But a company recognised
 * last week is simply absent from last quarter's file, and screening against it
 * produces a confident `not-sponsor` — a hard reject of a real opportunity, with
 * nothing anywhere to indicate it happened.
 */
export function registerStaleness(scrapedAt: Date | null, now: Date = new Date()): RegisterStaleness {
  if (scrapedAt === null) {
    return {
      stale: true,
      ageDays: null,
      note:
        "Register carries no scrape date, so its age cannot be established. " +
        "Re-scrape with: pnpm tsx scripts/ind-sponsors.ts",
    };
  }
  const ageDays = Math.floor((now.getTime() - scrapedAt.getTime()) / 86_400_000);
  if (ageDays > REGISTER_MAX_AGE_DAYS) {
    return {
      stale: true,
      ageDays,
      note:
        `Register is ${ageDays} days old (IND republishes monthly). A company recognised ` +
        `since ${scrapedAt.toISOString().slice(0, 10)} would be wrongly read as not-sponsor. ` +
        `Re-scrape with: pnpm tsx scripts/ind-sponsors.ts`,
    };
  }
  return { stale: false, ageDays, note: `Register scraped ${scrapedAt.toISOString().slice(0, 10)} (${ageDays}d old).` };
}

export interface SponsorRegister {
  readonly index: SponsorIndex;
  readonly scrapedAt: Date | null;
}

let cached: SponsorRegister | null = null;

/**
 * The register index, built on first use and cached for the process lifetime.
 * The register updates monthly (the 1st-of-month task in the campaign rhythm),
 * which is far longer than any process lifetime, so there is no staleness window
 * worth invalidating for.
 */
export function getSponsorRegister(): SponsorRegister {
  if (cached) return cached;

  let csv: string;
  try {
    csv = readFileSync(SPONSOR_REGISTER_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `IND sponsor register unreadable at ${SPONSOR_REGISTER_PATH}: ${(err as Error).message}. ` +
        `Regenerate it with: pnpm tsx scripts/ind-sponsors.ts`,
    );
  }

  const names = parseSponsorCsv(csv);
  if (names.length === 0) {
    throw new Error(
      `IND sponsor register at ${SPONSOR_REGISTER_PATH} parsed to zero entries. ` +
        `Screening against an empty register would reject the entire market.`,
    );
  }

  cached = { index: buildSponsorIndex(names), scrapedAt: parseScrapedAt(csv) };
  return cached;
}

export function getSponsorIndex(): SponsorIndex {
  return getSponsorRegister().index;
}

/** Test seam — drops the cached index so a fresh one is built on next use. */
export function resetSponsorIndexCache(): void {
  cached = null;
}
