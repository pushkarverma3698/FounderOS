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
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  // Drop the header row only if it actually is one.
  const body = lines[0]!.startsWith("name,") ? lines.slice(1) : lines;
  return body.map((line) => parseCsvLine(line)[0] ?? "").filter((n) => n.length > 0);
}

let cached: SponsorIndex | null = null;

/**
 * The register index, built on first use and cached for the process lifetime.
 * The register updates monthly (the 1st-of-month task in the campaign rhythm),
 * which is far longer than any process lifetime, so there is no staleness window
 * worth invalidating for.
 */
export function getSponsorIndex(): SponsorIndex {
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

  cached = buildSponsorIndex(names);
  return cached;
}

/** Test seam — drops the cached index so a fresh one is built on next use. */
export function resetSponsorIndexCache(): void {
  cached = null;
}
