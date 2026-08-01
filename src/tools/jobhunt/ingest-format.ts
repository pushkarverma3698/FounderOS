/**
 * FounderOS — ingest summary formatting
 * =====================================
 * How a screened batch reads back to the founder when he asks for a sweep by
 * hand. Split out of ingest.ts so that module is about fetching and screening
 * and this one is about presentation.
 *
 * NOTE ON AUDIENCE. This is the MANUAL path (`ingest_jobs`). The scheduled daily
 * sweep does not use it — it renders the ranked brief in brief.ts instead, which
 * is the artefact designed to end in an action. This one is a verdict breakdown
 * for someone who explicitly asked what a sweep just did.
 */

import type { IngestLine, IngestSummary } from "./ingest.js";

const GROUP_ORDER: ReadonlyArray<IngestLine["outcome"]> = [
  "pass",
  "flag",
  "reject",
  "duplicate",
  "error",
];

const GROUP_LABEL: Record<IngestLine["outcome"], string> = {
  pass: "PASS — clears every hard gate, safe to draft",
  flag: "NEEDS A HUMAN CHECK — one gate couldn't be settled from the posting",
  reject: "REJECT — a legal bar, not a preference",
  duplicate: "SKIPPED — already in the pipeline",
  error: "FAILED TO SCREEN",
};

export function formatIngestSummary(summary: IngestSummary): string {
  if (summary.fetched === 0) {
    return (
      "INGEST — 0 postings.\n\n" +
      "The feed returned nothing for this query. That is a measurement, not " +
      "necessarily a fault: Netherlands + 2–5 years + AI/backend in the last 24h " +
      "is a narrow slice. If it stays at 0 for several days, widen the titles or " +
      "the time range rather than assuming the sweep is broken."
    );
  }

  const counts = GROUP_ORDER.map(
    (g) => `${g}: ${summary.lines.filter((l) => l.outcome === g).length}`,
  ).join(" · ");

  const sections = GROUP_ORDER.flatMap((group) => {
    const rows = summary.lines.filter((l) => l.outcome === group);
    if (rows.length === 0) return [];
    const body = rows
      .map((r) => `  · ${r.company} — ${r.title}\n      ${r.detail}`)
      .join("\n");
    return [`${GROUP_LABEL[group]} (${rows.length})\n${body}`];
  });

  return `INGEST — ${summary.fetched} postings screened.\n${counts}\n\n${sections.join("\n\n")}`;
}
