/**
 * IND recognised-sponsor register → CSV + target shortlist
 * ========================================================
 * The IND publishes the register of organisations permitted to sponsor a Highly
 * Skilled Migrant permit as a plain HTML table — no CSV, no API, no search.
 * Only companies on this register can sponsor a non-EU hire, so it is the hard
 * filter that must be applied BEFORE any other targeting effort.
 *
 * Register is updated monthly by the IND.
 *
 * Usage:
 *   node --import tsx/esm scripts/ind-sponsors.ts            # fetch + write CSV
 *   node --import tsx/esm scripts/ind-sponsors.ts --match    # also print shortlist
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const REGISTER_URL =
  "https://ind.nl/en/public-register-recognised-sponsors/public-register-work";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT_CSV = join(ROOT, "docs/strategy/data/ind-sponsors-work.csv");

export interface Sponsor {
  readonly name: string;
  readonly kvk: string;
}

/** Strip tags and decode the handful of entities the register actually uses. */
export function cleanCell(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Parse the register's HTML table into rows, skipping the header. */
export function parseRegister(html: string): Sponsor[] {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  const out: Sponsor[] = [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map(cleanCell);
    if (cells.length < 2) continue;
    const [name, kvk] = cells;
    if (!name || !kvk) continue;
    if (!/^\d{6,10}$/.test(kvk)) continue; // drops the header row
    out.push({ name, kvk });
  }
  return out;
}

/**
 * Signals that a sponsor is plausibly an AI/data/software employer.
 * Deliberately broad — this narrows 12k names to a reviewable set; it does NOT
 * decide fit. Every hit still needs manual confirmation.
 */
const NAME_SIGNALS =
  /\b(ai|a\.i|artificial|intelligence|machine learning|ml|data|analytics|algorithm|neural|vector|deep|cognit|robot|autonom|software|tech|labs?|digital|cloud|platform|systems?|compute|semantic|search|infra)\b/i;

/** Companies worth checking by name regardless of what the signal regex says. */
const WATCHLIST = [
  "weaviate", "zeta alpha", "deeploy", "axelera", "adyen", "booking", "mollie",
  "mews", "picnic", "backbase", "bird", "messagebird", "miro", "elastic",
  "tomtom", "catawiki", "optiver", "imc", "flow traders", "asml", "philips",
  "databricks", "datadog", "snowflake", "uber", "netflix", "salesforce",
  "xomnia", "pacmed", "aidence", "orikami", "nedap", "afas", "exact",
  "gitlab", "framer", "bunq", "rabobank", "klm", "coolblue", "bol.com",
  "datasnipper", "bitvavo", "sendcloud", "otrium", "castor", "dataiku",
];

/** Whole-word match so "ing" can't match "Consulting"/"Holding"/"Engineering". */
export function matchesWatchlist(name: string): boolean {
  const lower = name.toLowerCase();
  return WATCHLIST.some((w) => {
    const escaped = w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(lower);
  });
}

export function shortlist(rows: readonly Sponsor[]): {
  watch: Sponsor[];
  signal: Sponsor[];
} {
  const watch = rows.filter((r) => matchesWatchlist(r.name));
  const watchKvk = new Set(watch.map((r) => r.kvk));
  const signal = rows.filter(
    (r) => !watchKvk.has(r.kvk) && NAME_SIGNALS.test(r.name),
  );
  return { watch, signal };
}

function toCsv(rows: readonly Sponsor[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  // The scrape stamp is load-bearing, not decoration: the screening gate reads it
  // to decide whether a "not on the register" answer is still trustworthy. Without
  // it a stale file silently hard-rejects newly recognised sponsors.
  const stamp = `# scraped: ${new Date().toISOString().slice(0, 10)}`;
  return [stamp, "name,kvk", ...rows.map((r) => `${esc(r.name)},${r.kvk}`)].join("\n");
}

async function main(): Promise<void> {
  const res = await fetch(REGISTER_URL, {
    headers: { "user-agent": "Mozilla/5.0 (research; personal job search)" },
  });
  if (!res.ok) throw new Error(`IND register fetch failed: ${res.status}`);

  const rows = parseRegister(await res.text());
  if (rows.length < 1000) {
    throw new Error(`Suspiciously few rows (${rows.length}) — register layout may have changed`);
  }

  mkdirSync(dirname(OUT_CSV), { recursive: true });
  writeFileSync(OUT_CSV, toCsv(rows), "utf8");
  console.log(`✓ ${rows.length} sponsors → ${OUT_CSV}`);

  if (process.argv.includes("--match")) {
    const { watch, signal } = shortlist(rows);
    console.log(`\n── WATCHLIST HITS (${watch.length}) ──`);
    for (const r of watch) console.log(`  ${r.name}  [${r.kvk}]`);
    console.log(`\n── NAME-SIGNAL HITS (${signal.length}) ──`);
    for (const r of signal.slice(0, 120)) console.log(`  ${r.name}  [${r.kvk}]`);
    if (signal.length > 120) console.log(`  … ${signal.length - 120} more in the CSV`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
