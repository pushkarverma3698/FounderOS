/**
 * FounderOS — Weekly Outbound Batch (Phase D)
 * ============================================
 * Turns a list of target companies into ONE prospecting prompt for the office.
 *
 * The prompt routes to the `research` department (read-only — no write tools,
 * so no HITL and safe to batch). It returns a ranked ICP digest; the founder
 * then drafts the winners via the existing sales flow ("draft outreach to X"),
 * which keeps the one-approval-per-thread HITL contract intact.
 *
 * `buildBatchPrompt` is pure + deterministic so it can be unit-tested without a
 * live model. The single batched call (vs one office run per company) is the
 * cheapest viable path — Pillar 0.
 */

/** Max companies scored in a single batch — keeps the prospecting loop bounded. */
export const MAX_BATCH = 8;

/**
 * Build the prospecting prompt for a batch of target companies.
 * @param targets company names or URLs (already trimmed/deduped by the caller)
 */
export function buildBatchPrompt(targets: string[]): string {
  const list = targets.map((t, i) => `${i + 1}. ${t}`).join("\n");

  return `Run our weekly outbound prospecting batch. Use the research department to evaluate each company below against the Turicks ICP:
- SME founders, EU/US, roughly $50K–500K ARR
- Pain: no technical co-founder; needs AI automation / fast product delivery
- Disqualify: enterprise (>500 staff), pure B2C, other agencies, no budget signal

For EACH company, return exactly one line in this format:
  <name> — ICP <score>/10 — <≤12-word rationale> — Next: <send | research | skip>

Then finish with a single "Shortlist:" line naming the companies scoring 7+ in priority order (or "Shortlist: none" if there are none).
Be concise — this is a mobile digest. Do not draft any emails; scoring only.

Companies:
${list}`;
}

/**
 * Split the targets into the batch that will be scored now and any overflow
 * beyond MAX_BATCH that the caller should report as deferred.
 */
export function splitBatch(targets: string[]): { batch: string[]; overflow: string[] } {
  return { batch: targets.slice(0, MAX_BATCH), overflow: targets.slice(MAX_BATCH) };
}

/**
 * Parse a raw command argument into a list of company names.
 * Comma-separated for multiple ("Acme Corp, Beta Ltd"); a single value with no
 * comma is treated as one company (names may contain spaces).
 */
export function parseCompanyArgs(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
