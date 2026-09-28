/**
 * FounderOS — job_state Tool (Tier 0 Deterministic State)
 * =======================================================
 * Deterministic read of `job_applications` table.
 * Answers "what state am I currently in" for captured jobs, applied roles,
 * waiting applications, and rejected postings.
 *
 * Always returns `{ count, total, rows }` where `total` is the unfiltered total
 * count in `job_applications` for the tenant — across every candidate, always,
 * regardless of `profile`.
 *
 * `count`/`rows` default to the founder's own queue when `profile` is omitted
 * (never "every candidate mixed together") — until 2026-09-07 this tool had no
 * profile filter at all, so a second registered candidate's rows were
 * indistinguishable from the founder's own in every reply. See
 * profile-config.ts's DEFAULT_PROFILE_ID doc for the history of this failure
 * mode; this tool was the one caller that never got fixed with the rest.
 */

import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { jobApplications, type JobApplication } from "../db/schema.js";
import type { UnifiedTool, ToolResult } from "./index.js";

import { queryJobState, ALL_PROFILES } from "../db/job-queries.js";
import { listProfiles, resolveProfileScope } from "./jobhunt/profile-config.js";
import { ageInDays } from "./jobhunt/brief-assemble.js";
import { ageLine } from "./jobhunt/brief-row.js";

/** "all" / "both" / "everyone" — the founder or the LLM asking for every candidate at once. */

// ── section vs track: two vocabularies that used to fail silently ─────────────

/**
 * The only four values `job_applications.brief_section` ever holds.
 *
 * Nothing enforced this before. `section` was passed through raw to an `eq()`,
 * so any other spelling returned `{ count: 0 }` with `success: true` — a
 * *filter miss* rendered identically to *an empty market*. Two spellings were
 * near-certain to be tried, and both were: the display headings this tool's own
 * description advertised ("DO TODAY", "ONE QUESTION AWAY"), which no row has
 * ever carried, and a value off `job_brief`'s track line ("accountant 4 · fpa
 * 7"), which is a different column entirely. On 2026-09-07 that second miss
 * sent a live run through repeated retries against a mismatch that was never a
 * data fact, and it was the token budget — not an error — that ended it.
 */
const BRIEF_SECTIONS = ["do_today", "stretch", "ask", "standing"] as const;

/**
 * Display heading → stored value, for the spellings a founder or a worker can
 * actually see. These are read off the rendered brief and off this tool's own
 * description, so accepting them is not leniency — it is closing the gap that
 * produced the silence.
 */
const SECTION_ALIASES: Record<string, (typeof BRIEF_SECTIONS)[number]> = {
  do_today: "do_today",
  dotoday: "do_today",
  "do today": "do_today",
  "apply today": "do_today",
  today: "do_today",
  stretch: "stretch",
  ask: "ask",
  "one question away": "ask",
  "one question": "ask",
  question: "ask",
  standing: "standing",
};

/** Normalise a `section` argument, or explain the miss in the words that fix it. */
function resolveSection(raw: string | undefined): { section?: string; error?: string } {
  if (raw === undefined) return {};
  const key = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const resolved = SECTION_ALIASES[key] ?? SECTION_ALIASES[key.replace(/ /g, "_")];
  if (resolved) return { section: resolved };
  return {
    error:
      `Unknown section "${raw}". \`section\` is the brief priority bucket and holds only: ` +
      `${BRIEF_SECTIONS.join(", ")} (headings "DO TODAY" / "ONE QUESTION AWAY" also accepted). ` +
      `If you meant the role classification job_brief prints ("accountant 4 · fpa 7 · auditor 1"), ` +
      `that is the \`track\` argument, not \`section\`. Known tracks: ${knownTracks().join(", ")}.`,
  };
}

/** Every track id any registered profile defines, plus the classifier's own miss value. */
function knownTracks(): string[] {
  const ids = new Set<string>(["unclassified"]);
  for (const profile of listProfiles()) {
    for (const id of Object.keys(profile.tracks)) ids.add(id);
  }
  return [...ids].sort();
}

/** Validate a `track` argument against what the profiles actually define. */
function resolveTrack(raw: string | undefined): { track?: string; error?: string } {
  if (raw === undefined) return {};
  const normalized = raw.trim().toLowerCase();
  const known = knownTracks();
  if (known.includes(normalized)) return { track: normalized };
  return {
    error:
      `Unknown track "${raw}". Known tracks: ${known.join(", ")}. ` +
      `If you meant the brief priority bucket, that is \`section\`: ${BRIEF_SECTIONS.join(", ")}.`,
  };
}

/**
 * `undefined` = no `profile` arg given → `queryJobState` defaults to
 * DEFAULT_PROFILE_ID, same as every other jobhunt query (profileCondition).
 * A string that does not resolve is a LOUD miss, not a silent cross-candidate
 * query: this tool mixed both profiles' rows for every caller until
 * 2026-09-07, which is exactly the bug being fixed here.
 */
function resolveProfileFilter(raw: string | undefined): { profileId?: string | typeof ALL_PROFILES; error?: string } {
  // One implementation, in profile-config.ts — this file and job-state.ts
  // carried byte-identical copies until 2026-09-08.
  return resolveProfileScope(raw, ALL_PROFILES);
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * "posted 3d ago · found today" on every row — computed here, by the brief's own
 * `ageInDays` + `ageLine`, not left to the model.
 *
 * On 2026-09-07 the founder asked "are these of today?" four times in five
 * minutes about a free-text answer built from `created_at` alone. The command
 * views print this exact line; handing the model a bare timestamp made it do the
 * date arithmetic, and "found today" got read as "posted today". A null
 * `posted_at` says "posted date not stated", never our own storage date.
 */
function withAgeLabel<T extends object>(row: T, now: Date): T & { age: string } {
  const r = row as { posted_at?: unknown; created_at?: unknown };
  const posted = asDate(r.posted_at);
  return { ...row, age: ageLine(posted ? ageInDays(posted, now) : null, ageInDays(asDate(r.created_at), now)) };
}

export const jobStateTool: UnifiedTool = {
  name: "job_state",
  description:
    "Deterministic read of captured job applications from Postgres. " +
    "Use this tool for state questions ('show all jobs', 'how many jobs in pipeline', 'which ones applied to', 'what was rejected'). " +
    "Do NOT use job_brief for factual listing questions. Returns { count, total, rows }. " +
    "`total` is ALWAYS the unfiltered count across every registered candidate, never just the " +
    "one `profile` filtered to — never report `total` as one candidate's number.",

  input_schema: {
    type: "object",
    properties: {
      profile: {
        type: "string",
        description:
          "REQUIRED whenever the question names a specific candidate (e.g. 'Tashi', 'my wife', " +
          "'Pushkar'). Accepts a profile id (e.g. 'wife-nl-finance'), a first name, or 'all' for " +
          "every candidate at once. Omitting this when more than one profile is registered " +
          "defaults to the founder's own queue — it does NOT mean 'everyone'.",
      },
      stage: {
        type: "string",
        description: "Filter by stage (e.g. 'screened', 'drafted', 'awaiting_approval', 'applied', 'replied', 'rejected').",
      },
      section: {
        type: "string",
        description:
          "Filter by brief PRIORITY BUCKET. One of: do_today, stretch, ask, standing " +
          "(the headings 'DO TODAY' / 'ONE QUESTION AWAY' are accepted too). " +
          "This is NOT the role classification — for 'accountant', 'fpa', 'ai', use `track`. " +
          "An unrecognised value is refused, never silently answered with 0 rows.",
      },
      track: {
        type: "string",
        description:
          "Filter by ROLE CLASSIFICATION — the column job_brief prints as " +
          "'accountant 4 · fpa 7 · auditor 1'. Use this whenever the question names a kind " +
          "of role rather than a priority bucket.",
      },
      source: {
        type: "string",
        description: "Filter by route/source (e.g. 'hsm', 'free-ats').",
      },
      applied: {
        type: "boolean",
        description: "Filter applied status: true for applied_at != null, false for unapplied.",
      },
      since: {
        type: "string",
        description:
          "Found since: rows WE FIRST SAW (created_at) at or after this ISO timestamp. " +
          "It is not a posting-date filter — when the employer published a role is `posted_at` " +
          "(null when the posting did not say). Every row's `age` states both.",
      },
      fullDetails: {
        type: "boolean",
        description: "Set true to include all 40 DB columns instead of curated summary fields.",
      },
      limit: {
        type: "number",
        description: "Max rows to return (default: 50, max: 200).",
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const profile = resolveProfileFilter(args["profile"] as string | undefined);
      if (profile.error) {
        return { success: false, error: profile.error };
      }
      const section = resolveSection(args["section"] as string | undefined);
      if (section.error) {
        return { success: false, error: section.error };
      }
      const track = resolveTrack(args["track"] as string | undefined);
      if (track.error) {
        return { success: false, error: track.error };
      }

      const result = await queryJobState({
        profileId: profile.profileId,
        stage: args["stage"] as string | undefined,
        section: section.section,
        track: track.track,
        source: args["source"] as string | undefined,
        applied: typeof args["applied"] === "boolean" ? (args["applied"] as boolean) : undefined,
        since: args["since"] as string | undefined,
        fullDetails: typeof args["fullDetails"] === "boolean" ? (args["fullDetails"] as boolean) : undefined,
        limit: typeof args["limit"] === "number" ? (args["limit"] as number) : undefined,
      });

      const now = new Date();
      return {
        success: true,
        data: JSON.stringify({ ...result, rows: result.rows.map((row) => withAgeLabel(row, now)) }, null, 2),
        observed: {
          kind: "record",
          evidence: `count:${result.count},total:${result.total}`,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to query job state: ${(err as Error).message}`,
      };
    }
  },
};
