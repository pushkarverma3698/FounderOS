/**
 * FounderOS — sponsor-match uncertain-rate measurement
 * ====================================================
 * `uncertain` from `matchSponsor` becomes `flag` in screen_job, which becomes a
 * line in the founder's daily approval queue. So the uncertain-rate IS the
 * attention cost of the gate, and any change to the matching rule has to be
 * measured on real names before and after — not argued about.
 *
 *   node --import tsx/esm scripts/jobhunt-sponsor-uncertain-rate.ts
 *
 * $0: pure string work against the committed register CSV. No model, no network,
 * no DB. Deterministic — the samples are drawn with a seeded LCG, so two runs on
 * the same register produce identical numbers and are safe to diff across a fix.
 *
 * Four samples, because one number cannot show both halves of the tradeoff:
 *   REAL     — company names as job ads actually write them (the headline).
 *   ABBREV   — register entries truncated the way ads abbreviate them
 *              ("ASML Netherlands B.V." → "ASML"). These SHOULD stay uncertain;
 *              a drop here is lost recall, i.e. missed real sponsors.
 *   DECORATED— a full register name plus a noise word ("… B.V. Amsterdam").
 *              These should stay uncertain too; `not-sponsor` here is a false
 *              negative, the cost side of tightening the rule.
 *   GENERIC  — an invented company sharing one category word with the register
 *              ("Kwyjibo Analytics"). These SHOULD be not-sponsor; every
 *              uncertain here is pure queue noise.
 */

import { matchSponsor, type SponsorIndex, type SponsorVerdict } from "../src/tools/jobhunt/sponsor-match.js";
import { getSponsorIndex } from "../src/tools/jobhunt/sponsor-registry.js";

/** Company names as postings write them: real sponsors, real non-sponsors, generic-sounding shops. */
const REAL_NAMES = [
  "Adyen", "Booking.com", "ASML", "Picnic Technologies", "Mollie", "Bunq", "Backbase",
  "Elastic", "Databricks Netherlands", "Uber Netherlands", "Miro", "Notion",
  "Kwyjibo Analytics", "Fnordling Systems", "Zzyzx Widgetworks", "Optiver", "IMC Trading",
  "Flow Traders", "Coolblue", "bol.com", "TomTom", "Nedap", "Sioux Technologies", "Xebia",
  "Deloitte Consulting", "Accenture Netherlands", "Randstad Digital", "Sopra Steria Benelux",
  "Cegeka Nederland", "Info Support", "Ordina", "Luminis Arnhem", "Sentia Group",
  "Solution Architects Group", "Data Analytics Consulting", "AI Solutions Amsterdam",
  "Cloud Services International", "Digital Engineering Partners",
] as const;

const NOISE_WORDS = ["Netherlands", "Amsterdam", "Careers"] as const;
const SAMPLE_SIZE = 400;

/** Seeded LCG — the samples must be identical across runs to be diffable. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

type Tally = Record<SponsorVerdict, number>;

function tally(names: readonly string[], index: SponsorIndex): Tally {
  const counts: Tally = { sponsor: 0, "not-sponsor": 0, uncertain: 0 };
  for (const name of names) counts[matchSponsor(name, index).verdict]++;
  return counts;
}

function line(label: string, counts: Tally, want: string): string {
  const total = counts.sponsor + counts["not-sponsor"] + counts.uncertain;
  const pct = ((100 * counts.uncertain) / total).toFixed(1);
  return (
    `  ${label.padEnd(10)} n=${String(total).padStart(4)}  ` +
    `uncertain ${pct.padStart(5)}%  sponsor ${String(counts.sponsor).padStart(4)}  ` +
    `not-sponsor ${String(counts["not-sponsor"]).padStart(4)}   (want: ${want})`
  );
}

/** Identity tokens of a normalised key, mirroring the matcher's own rule closely enough to build samples. */
function tokensOf(key: string): string[] {
  return key.split(" ").filter((t) => t.length >= 3);
}

function main(): void {
  const index = getSponsorIndex();
  const keys = [...index.keys()];
  const rand = seededRandom(7);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  const abbrev: string[] = [];
  const decorated: string[] = [];
  const generic: string[] = [];
  const multiToken = keys.filter((k) => tokensOf(k).length >= 2);

  for (let i = 0; i < SAMPLE_SIZE; i++) {
    abbrev.push(tokensOf(pick(multiToken)).slice(0, -1).join(" "));
    decorated.push(`${index.get(pick(keys))!} ${pick(NOISE_WORDS)}`);
  }
  // Category words: tokens carried by many entries. An unrelated company that
  // happens to use one is the noise case the queue drowns in.
  const frequency = new Map<string, number>();
  for (const key of keys) for (const t of new Set(tokensOf(key))) frequency.set(t, (frequency.get(t) ?? 0) + 1);
  const categoryWords = [...frequency.entries()].filter(([, n]) => n >= 20).map(([t]) => t);
  for (let i = 0; i < SAMPLE_SIZE; i++) generic.push(`Kwyjibo ${pick(categoryWords)}`);

  console.log(`register: ${index.size} indexed entries, ${categoryWords.length} category words (>=20 entries)\n`);
  console.log(line("REAL", tally(REAL_NAMES, index), "low uncertain, sponsors intact"));
  console.log(line("ABBREV", tally(abbrev, index), "uncertain stays high — recall"));
  console.log(line("DECORATED", tally(decorated, index), "uncertain stays high — recall"));
  console.log(line("GENERIC", tally(generic, index), "uncertain near 0 — noise"));

  console.log("\nREAL, name by name:");
  for (const name of REAL_NAMES) {
    const match = matchSponsor(name, index);
    console.log(`  ${name.padEnd(30)} ${match.verdict.padEnd(12)} ${match.candidates.length} candidate(s)`);
  }
}

main();
