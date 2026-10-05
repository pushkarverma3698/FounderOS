/**
 * FounderOS — which role a job command means
 * ==========================================
 * `/draft`, `/ask` and `/applied` take EITHER a row number from the latest brief (a position: re-ranked every
 * sweep, so only good for minutes) OR the id an alert printed (the role itself: good for as long as the row exists).
 *
 * Both resolve by pure lookup. A miss, an ambiguity and a role that belongs to the other candidate are each a
 * refusal that says why. None of them falls back to the other form: the cost of guessing is a tailored
 * application sent about the wrong company.
 */

import type { BriefSection } from "../db/job-queries.js";
import { findApplicationsByIdPrefix } from "../db/job-ref-queries.js";
import type { JobApplication } from "../db/schema.js";
import { resolveBriefRow } from "../tools/jobhunt/apply-packet.js";
import { parseJobId, shortJobId } from "../tools/jobhunt/job-ref.js";
import { listProfiles, profileSelector, type JobSearchProfile } from "../tools/jobhunt/profile-config.js";

/** Stages where the application already went out or the role is closed: drafting or asking again is a mistake. */
const CLOSED_STAGES: readonly string[] = ["applied", "replied", "rejected", "dormant"];

/**
 * Parse the row number out of "/draft 2".
 *
 * Returns null for anything that is not a plain positive integer. "2nd", "two"
 * and "" are all refusals rather than guesses — the cost of picking wrong is a
 * tailored application sent about the wrong company.
 */
export function parseRowArg(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || !trimmed.split("").every((c) => c >= "0" && c <= "9")) return null;
  const n = Number(trimmed);
  return n >= 1 ? n : null;
}

/**
 * Which sections each command addresses, in the words the brief prints them in.
 *
 * `/draft` spans two since 2026-08-06: DO TODAY and the stretch section share
 * one continuous numbering, because a row flagged only on the years bar needs an
 * APPLICATION, not a question. Naming only the first would tell the founder his
 * row is missing from a section it was never in.
 */
const COMMAND_SECTIONS: Readonly<Record<string, string>> = {
  draft: "DO TODAY / A STRETCH WORTH APPLYING TO",
  apply: "DO TODAY / A STRETCH WORTH APPLYING TO",
  applied: "DO TODAY / A STRETCH WORTH APPLYING TO",
  ask: "ONE QUESTION AWAY",
};

/** What to say when the number does not resolve. Never a silent no-op. */
export function unresolvedMessage(command: string, rank: number | null): string {
  if (rank === null) {
    return (
      `Usage: /${command} <number> — the number next to a row in the latest job brief, ` +
      `or the id an alert printed (like j3a9f2c1).\nExample: /${command} 1`
    );
  }
  return (
    `No row ${rank} in the latest brief's ${COMMAND_SECTIONS[command] ?? "actionable"} ` +
    `section.\n\nThe numbers come from the most recent brief only. Ask me for the job brief to ` +
    `get a current list.`
  );
}

export type RowRef =
  | { readonly kind: "rank"; readonly rank: number }
  | { readonly kind: "id"; readonly hex: string };

/** A row number, or an id an alert printed. Null for anything else: a usage line, never a guess. */
export function parseRowRef(raw: string): RowRef | null {
  const rank = parseRowArg(raw);
  if (rank !== null) return { kind: "rank", rank };
  const hex = parseJobId(raw);
  return hex === null ? null : { kind: "id", hex };
}

export type RowResolution =
  | { readonly ok: true; readonly row: JobApplication }
  | { readonly ok: false; readonly message: string };

const refuse = (message: string): RowResolution => ({ ok: false, message });

/** The exact line to type for this role and this candidate, selector included. */
function typedCommand(command: string, owner: { id: string; candidateName: string } | undefined, row: JobApplication): string {
  const selector = owner ? profileSelector(owner) : "";
  return ["/" + command, selector, shortJobId(row.id)].filter((part) => part.length > 0).join(" ");
}

async function resolveById(command: string, hex: string, profile: JobSearchProfile): Promise<RowResolution> {
  const typed = "j" + hex;
  const found = await findApplicationsByIdPrefix(hex, profile.tenantId);
  const row = found[0];
  if (!row) {
    return refuse(`No role with id ${typed} found. It may have been removed. Send /jobs for the current list.`);
  }
  if (found.length > 1) {
    return refuse(`The id ${typed} matches more than one role. Type a few more characters of it.`);
  }
  if (row.profile_id !== profile.id) {
    const owner = listProfiles().find((p) => p.id === row.profile_id);
    const who = owner ? owner.candidateName : "another candidate";
    return refuse(`${row.company} belongs to ${who}, not to this queue. Send ${typedCommand(command, owner, row)} instead.`);
  }
  if (command !== "applied" && CLOSED_STAGES.includes(row.stage)) {
    const state = row.stage === "applied" || row.stage === "replied" ? "already applied to" : "marked " + row.stage;
    return refuse(`${row.company} (${row.title}) is ${state}. Nothing to ${command}.`);
  }
  return { ok: true, row };
}

/**
 * Resolve one reference to one row. A position is read against the live brief, in the sections the command
 * addresses. An id is read against the table, so it keeps resolving after every re-rank and in any section.
 */
export async function resolveRowRef(
  ref: RowRef,
  command: string,
  sections: readonly BriefSection[],
  profile: JobSearchProfile,
): Promise<RowResolution> {
  if (ref.kind === "id") return resolveById(command, ref.hex, profile);
  const row = await resolveBriefRow(ref.rank, sections, profile);
  return row ? { ok: true, row } : refuse(unresolvedMessage(command, ref.rank));
}

export const rankRef = (rank: number): RowRef => ({ kind: "rank", rank });
export const idRef = (hex: string): RowRef => ({ kind: "id", hex });
