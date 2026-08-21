/**
 * FounderOS — what /draft and /ask tell the model
 * ===============================================
 * The two prompt composers, split out of jobhunt-commands.ts when `/draft all`
 * pushed that file past the 400-line CI budget. The seam is a real one: these
 * two functions are pure string composition over a row and its gates, they are
 * where the "only assert what PASSED" rule is enforced, and they are the part of
 * the command surface with its own tests.
 */

import { blockingGates, parseGates } from "../tools/jobhunt/gates.js";
import type { JobApplication } from "../db/schema.js";

/** Enough of the posting for a tailored draft; the full body can reach 20k chars. */
const POSTING_EXCERPT_CHARS = 6_000;

/**
 * The drafting instruction for a row that cleared every gate.
 *
 * The checks are listed WITH their status rather than as one flattened string,
 * because they mean opposite things to a drafter: a passing sponsor check is
 * something the letter can lean on ("you're a recognised sponsor, so the permit
 * side is straightforward"), while an unsettled one is something it must not
 * assert.
 */
export function draftInstruction(row: JobApplication): string {
  const { gates } = parseGates(row);
  const evidence =
    gates.length > 0
      ? gates.map((g) => `- [${g.status.toUpperCase()}] ${g.gate}: ${g.evidence}`).join("\n")
      : `- ${row.salary_evidence ?? "none recorded"}`;

  return (
    `Draft a tailored application for this role. Call read_cv FIRST and lead with the ` +
    `strongest matching technical signal. Do NOT send anything — produce the draft for me to read.\n\n` +
    `Company: ${row.company}\n` +
    `Role: ${row.title}\n` +
    `Permit basis: ${row.route}\n` +
    `${row.url ? `URL: ${row.url}\n` : ""}` +
    `\nScreening checks (only assert what is marked PASS):\n${evidence}\n\n` +
    `Posting:\n${(row.description ?? "").slice(0, POSTING_EXCERPT_CHARS)}`
  );
}

/**
 * The question instruction for a flagged row.
 *
 * ONLY THE UNRESOLVED GATES GO IN. Until 2026-08-01 this pasted the entire
 * `salary_evidence` string — every check, passing ones included — under the
 * heading "What is unresolved". A row whose sponsor and language checks had
 * PASSED handed the model three gates and asked it to write one question about
 * them, so the question came back generic. The founder gets one message to an
 * employer; spending it on a check that already passed wastes it.
 *
 * The passing gates are still supplied, clearly labelled as settled, because
 * they are context for the wording — "you're a recognised sponsor, so my
 * question is only about X" is a better message than one written blind.
 */
export function askInstruction(row: JobApplication): string {
  const { gates, legacy } = parseGates(row);
  const unresolved = blockingGates({ status: "flag", gates });
  const settled = gates.filter((g) => g.status === "pass");

  // A row screened before `gate_json` existed has no per-check status at all, so
  // every check reads as unresolved. Saying that out loud is the difference
  // between a model working from an honest gap and one told three settled checks
  // are open — which is the failure this whole change exists to close.
  const legacyNote = legacy
    ? `\n(This row predates our per-check record, so we cannot tell which of these ` +
      `already passed. Ask about the one that most plausibly blocks an offer.)`
    : "";

  const unresolvedText =
    unresolved.length > 0
      ? unresolved.map((g) => `- ${g.gate}: ${g.evidence}`).join("\n") + legacyNote
      : `- (no per-check record for this row) ${row.salary_evidence ?? "nothing recorded"}`;

  return (
    `Write ONE short, specific question to send this employer. It must resolve the ` +
    `UNRESOLVED check(s) below and nothing else — do not ask about the role in general, ` +
    `and do not ask about anything listed as already settled. ` +
    `Do NOT send it; show me the draft.\n\n` +
    `Company: ${row.company}\n` +
    `Role: ${row.title}\n` +
    `Permit basis under consideration: ${row.route}\n` +
    `${row.url ? `URL: ${row.url}\n` : ""}` +
    `\nUNRESOLVED — this is what the question must settle:\n${unresolvedText}\n` +
    (settled.length > 0
      ? `\nALREADY SETTLED — context only, do NOT ask about these:\n` +
        settled.map((g) => `- ${g.gate}: ${g.evidence}`).join("\n")
      : "")
  );
}

