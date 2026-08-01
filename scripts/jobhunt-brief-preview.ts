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
    country: "NL",
    location: "Amsterdam, North Holland, Netherlands",
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
  notes: [
    "Indeed NL: 8 listing(s) skipped — the employer has already closed them.",
    "ATS india/backend: 3 repeat listing(s) collapsed — the feed returned the same role more than once. Billed for, screened once.",
  ],
  spend: { runs: 14, returned: 61, costUsd: 0.91, failed: 0 },
  trends: [
    { track: "ai", sampleSize: 11, term: "LangChain", seenCount: 7, absentDays: 12 },
    { track: "fullstack", sampleSize: 14, term: "Kubernetes", seenCount: 9, absentDays: 21 },
  ],
  rows: [
    // Two Indian rows and one third-country row, so the preview exercises the
    // market split rather than only the Netherlands block it was written for.
    row({
      id: "in1",
      company: "Zeta Suite",
      title: "Backend Engineer",
      track: "backend",
      route: "india-local",
      country: "IN",
      location: "Bengaluru, Karnataka, India",
      gates: [
        {
          gate: "Basis",
          status: "pass",
          evidence:
            "Based in India, where you already live and already have the right to work. No " +
            "permit, no sponsor and no salary criterion is involved — only whether the role " +
            "and the pay are worth taking.",
        },
        {
          gate: "Pay",
          status: "pass",
          evidence: '\u20b924 LPA — at or above your \u20b915 LPA line. Read from: "18 - 24 LPA".',
        },
        EXPERIENCE_PASS,
      ],
      overlap: { matched: ["Node.js", "PostgreSQL"], missing: ["Kafka"], asked: 3, ratio: 0.67 },
    }),
    row({
      id: "in2",
      company: "Innovaccer",
      title: "AI Engineer",
      track: "ai",
      route: "india-local",
      country: "IN",
      location: "Noida, Uttar Pradesh, India",
      verdict: "flag",
      gates: [
        {
          gate: "Basis",
          status: "pass",
          evidence: "Based in India, where you already live and already have the right to work.",
        },
        {
          gate: "Pay",
          status: "flag",
          evidence:
            "\u20b99 LPA is below your \u20b915 LPA line. Nothing here bars the role — it is " +
            "lawful and you can apply — but it is worth a deliberate look before spending an " +
            'application on it. Read from: "9 LPA".',
        },
        EXPERIENCE_PASS,
      ],
      overlap: { matched: ["Python", "LangChain"], missing: [], asked: 2, ratio: 1 },
    }),
    row({
      id: "other1",
      company: "Periferia IT Group",
      title: "Fullstack Developer",
      country: "other",
      location: "Bogotá, Colombia",
      route: "remote-contract",
      verdict: "flag",
      gates: [
        {
          gate: "Location",
          status: "flag",
          evidence:
            "This role is based in a country outside both your markets — it is not a Dutch " +
            "role and not an Indian one. You cannot be hired locally there, so the only way " +
            "it works is as a remote contract billed from India. Confirm the employer will " +
            "do that before applying.",
        },
        BASIS_PASS,
        EXPERIENCE_PASS,
      ],
      overlap: { matched: ["React", "Node.js"], missing: ["Go"], asked: 3, ratio: 0.67 },
    }),
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
