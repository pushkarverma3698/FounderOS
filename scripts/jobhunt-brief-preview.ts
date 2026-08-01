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

function row(over: Partial<BriefRow> & Pick<BriefRow, "id" | "company" | "title">): BriefRow {
  return {
    track: "fullstack",
    verdict: "pass",
    route: "partner-permit route",
    url: "https://boards.greenhouse.io/example/jobs/1",
    overlap: { matched: ["React", "TypeScript", "Node.js"], missing: [], asked: 3, ratio: 1 },
    liveness: "live",
    headline: "Clears every gate on this basis.",
    ageDays: 0,
    ...over,
  };
}

const input: BriefInput = {
  date: new Date("2026-08-02T01:30:00Z"),
  screened: 47,
  perTrack: { ai: 11, fullstack: 14, backend: 13, frontend: 9 },
  failures: [],
  trends: [
    { track: "ai", sampleSize: 11, term: "LangChain", seenCount: 7, absentDays: 12 },
    { track: "fullstack", sampleSize: 14, term: "Kubernetes", seenCount: 9, absentDays: 21 },
  ],
  rows: [
    row({
      id: "1",
      company: "Bloom & Wild Group",
      title: "Senior Full-Stack Engineer",
      overlap: {
        matched: ["React", "TypeScript", "Node.js", "PostgreSQL"],
        missing: ["Kubernetes"],
        asked: 5,
        ratio: 0.8,
      },
      headline:
        "No salary stated — normal for Dutch postings, and no IND criterion applies on this " +
        "basis, so it is not a bar. Pay is unconfirmed: ask at first contact.",
    }),
    row({
      id: "2",
      company: "Adyen N.V.",
      title: "Backend Engineer, Payments Platform",
      track: "backend",
      route: "sponsorship route",
      headline: "Adyen N.V. is on the IND recognised-sponsor register (exact match).",
      overlap: {
        matched: ["Node.js", "PostgreSQL"],
        missing: ["Go", "Kafka"],
        asked: 4,
        ratio: 0.5,
      },
      ageDays: 4,
    }),
    row({
      id: "3",
      company: "Sytac",
      title: "Founding Engineer",
      liveness: "unverifiable",
      verdict: "flag",
      headline: "Posting asks for 'fluent Dutch' in the requirements — confirm whether it is hard.",
      overlap: { matched: ["React", "Node.js"], missing: ["Angular"], asked: 3, ratio: 0.67 },
    }),
    row({
      id: "4",
      company: "Deloitte Netherlands",
      title: "Junior Data Engineer",
      verdict: "reject",
      route: "sponsorship route",
      headline: "Stated salary €38,000 is below the €52,284 IND criterion for the under-30 band.",
    }),
    row({
      id: "5",
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
