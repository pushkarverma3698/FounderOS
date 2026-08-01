/**
 * Render the daily brief with representative data — $0, no DB, no network.
 *
 * The brief is the ONLY artefact of this pipeline the founder actually reads, and
 * its layout cannot be judged from a unit test asserting `toContain("APPLY
 * TODAY")`. This renders it with data shaped like a real day so the wording,
 * spacing and hierarchy can be looked at directly.
 *
 * Prints the raw Telegram HTML and the byte count, because a brief over 4,096
 * characters is split into multiple messages and that changes how it reads.
 *
 *   npx tsx scripts/jobhunt-brief-preview.ts
 */

import {
  formatDailyBrief,
  splitForTelegram,
  type BriefInput,
  type BriefRow,
} from "../src/tools/jobhunt/brief.js";
import type { Gate } from "../src/tools/jobhunt/gates.js";

const SPONSOR_PASS: Gate = {
  gate: "Sponsor",
  status: "pass",
  evidence: 'Exact register match: "Adyen N.V." (normalised "adyen").',
};
const SPONSOR_FLAG: Gate = {
  gate: "Sponsor",
  status: "flag",
  evidence:
    '"Sytac" partially overlaps 2 register entry/entries (Sytac B.V., Sytac Consulting). ' +
    "Needs a human check — a wrong guess here wastes an entire application.",
};
const BASIS_PASS: Gate = {
  gate: "Basis",
  status: "pass",
  evidence: "Partner permit — no employer sponsorship needed, so the register does not gate this.",
};
const SALARY_FLAG: Gate = {
  gate: "Salary",
  status: "flag",
  evidence:
    "No salary stated — normal for Dutch postings. Not a bar on this basis, but the pay is " +
    "unconfirmed: ask at first contact.",
};
const SALARY_PASS: Gate = {
  gate: "Salary",
  status: "pass",
  evidence: "Stated €65,000/yr clears the €52,284 IND criterion for the under-30 band.",
};
const SALARY_REJECT: Gate = {
  gate: "Salary",
  status: "reject",
  evidence: "Stated €38,000 is below the €52,284 IND criterion for the under-30 band.",
};
const LANGUAGE_PASS: Gate = {
  gate: "Language",
  status: "pass",
  evidence: "No Dutch-language requirement found in the posting.",
};
const LANGUAGE_FLAG: Gate = {
  gate: "Language",
  status: "flag",
  evidence: "Posting mentions 'fluent Dutch' in the requirements — confirm whether it is hard.",
};
const EXPERIENCE_PASS: Gate = {
  gate: "Experience",
  status: "pass",
  evidence:
    'Asks for 3 year(s) — within reach of your ~3.5 shipped. Their words: "3+ years building ' +
    'production web applications".',
};
const EXPERIENCE_REJECT: Gate = {
  gate: "Experience",
  status: "reject",
  evidence:
    'Asks for 8 years minimum; you have ~3.5 shipped. Their words: "8+ years of experience ' +
    'operating large-scale Kubernetes platforms". Skipped so the day\'s applications go to ' +
    "roles that can actually shortlist you.",
};

function row(over: Partial<BriefRow> & Pick<BriefRow, "id" | "company" | "title">): BriefRow {
  return {
    track: "fullstack",
    verdict: "pass",
    route: "partner-permit route",
    url: "https://boards.greenhouse.io/example/jobs/1",
    overlap: { matched: ["React", "TypeScript", "Node.js"], missing: [], asked: 3, ratio: 1 },
    liveness: "live",
    gates: [BASIS_PASS, SALARY_PASS, LANGUAGE_PASS, EXPERIENCE_PASS],
    legacyGates: false,
    ageDays: 0,
    ...over,
  };
}

const input: BriefInput = {
  date: new Date("2026-08-02T01:30:00Z"),
  screened: 47,
  perTrack: { ai: 11, fullstack: 14, backend: 13, frontend: 9 },
  failures: [],
  spend: { runs: 10, returned: 47, costUsd: 0.664, failed: 0 },
  trends: [
    { track: "ai", sampleSize: 11, term: "LangChain", seenCount: 7, absentDays: 12 },
    { track: "fullstack", sampleSize: 14, term: "Kubernetes", seenCount: 9, absentDays: 21 },
  ],
  rows: [
    row({
      id: "1",
      company: "Bloom & Wild Group",
      title: "Senior Full-Stack Engineer",
      gates: [BASIS_PASS, SALARY_FLAG, LANGUAGE_PASS, EXPERIENCE_PASS],
      verdict: "flag",
      overlap: {
        matched: ["React", "TypeScript", "Node.js", "PostgreSQL"],
        missing: ["Kubernetes"],
        asked: 5,
        ratio: 0.8,
      },
    }),
    row({
      id: "2",
      company: "Adyen N.V.",
      title: "Backend Engineer, Payments Platform",
      track: "backend",
      route: "sponsorship route",
      gates: [SPONSOR_PASS, SALARY_PASS, LANGUAGE_PASS, EXPERIENCE_PASS],
      overlap: { matched: ["Node.js", "PostgreSQL"], missing: ["Go", "Kafka"], asked: 4, ratio: 0.5 },
      ageDays: 4,
    }),
    row({
      id: "3",
      company: "Sytac",
      title: "Founding Engineer",
      liveness: "unverifiable",
      verdict: "flag",
      gates: [SPONSOR_FLAG, SALARY_PASS, LANGUAGE_FLAG, EXPERIENCE_PASS],
      overlap: { matched: ["React", "Node.js"], missing: ["Angular"], asked: 3, ratio: 0.67 },
    }),
    row({
      id: "4",
      company: "Deloitte Netherlands",
      title: "Data Engineer",
      verdict: "reject",
      route: "sponsorship route",
      gates: [SPONSOR_PASS, SALARY_REJECT, LANGUAGE_PASS, EXPERIENCE_PASS],
    }),
    row({
      id: "5",
      company: "Booking.com",
      title: "Senior Platform Engineer",
      verdict: "reject",
      route: "sponsorship route",
      gates: [SPONSOR_PASS, SALARY_PASS, LANGUAGE_PASS, EXPERIENCE_REJECT],
    }),
    row({
      id: "6",
      company: "Ghost Co",
      title: "Platform Engineer",
      liveness: "expired",
    }),
  ],
};

const brief = formatDailyBrief(input);
const parts = splitForTelegram(brief);

console.log(brief);
console.log(`\n${"─".repeat(60)}`);
console.log(`${brief.length} chars · ${parts.length} Telegram message(s)`);
parts.forEach((p, i) => console.log(`  part ${i + 1}: ${p.length} chars`));
