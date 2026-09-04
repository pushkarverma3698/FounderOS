/**
 * FounderOS — the apply profile
 * =============================
 * The founder's answers to the questions every application form asks, held in
 * one file so the Mac client, the bookmarklet and the headless driver all fill
 * forms from the same facts.
 *
 * WHY IT EXISTS AT ALL. `mac-client` has shipped a working browser queue since
 * 2026-08-06 — adapters, an overlay, a ledger, a LaunchAgent that syncs on wake
 * and announces "4 jobs ready" in Telegram. On 2026-08-24 that LaunchAgent was
 * still succeeding daily and the founder had submitted **two** applications in
 * three weeks, because `apply-profile.json` was never copied from the example
 * and every single run stopped on its first line:
 *
 *     ✗ No apply profile at …/mac-client/apply-profile.json
 *
 * A required file with no owner is not a configuration step, it is a defect.
 * The file now lives on the VPS next to the CVs, `sync.py` pulls it on wake, and
 * `/profile` edits it — so there is one copy, it is the one the founder can
 * reach from his phone, and nothing depends on him having run a `cp` weeks ago.
 *
 * NOTHING HERE IS INVENTED, and that is enforced by shape rather than by
 * intention: every field is optional except the four an ATS always demands, and
 * a field that is absent is absent on the form for the founder to complete. The
 * alternative is a tool that types a guessed answer into an employer's
 * application — and on a work-authorisation question a guessed answer is a false
 * statement, not a typo.
 *
 * Pure except for the two file operations at the bottom. Parsing, validation and
 * rendering are testable with no filesystem.
 */

import { z } from "zod";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_PROFILE_ID } from "./profile-config.js";

/**
 * What the founder may state about his own right to work.
 *
 * A CLOSED SET, not free text, because this value decides which option gets
 * ticked on the question with legal weight. Free text would force the filler to
 * interpret a sentence, and "interpreting a sentence about visa status" is
 * exactly the operation that must not happen automatically.
 *
 * `unknown` is the default and is a real answer: it makes every eligibility
 * question an `ask`, which is the correct behaviour for a profile nobody has
 * confirmed.
 */
export const WORK_AUTHORIZATION = [
  "authorized-no-sponsorship",
  "requires-sponsorship",
  "unknown",
] as const;

export type WorkAuthorization = (typeof WORK_AUTHORIZATION)[number];

const answersSchema = z
  .object({
    location_city: z.string().optional(),
    location_country: z.string().optional(),
    work_authorization: z.enum(WORK_AUTHORIZATION).default("unknown"),
    /** Free text, shown to the founder, never typed into a form on its own. */
    work_authorization_detail: z.string().optional(),
    salary_floor_eur_year: z.number().positive().optional(),
    salary_floor_basis: z.string().optional(),
    years_experience: z.number().nonnegative().optional(),
    notice_period_days: z.number().nonnegative().optional(),
    notice_period_detail: z.string().optional(),
    needs_relocation: z.boolean().optional(),
    willing_to_relocate: z.boolean().optional(),
  })
  .partial({ work_authorization: true });

/**
 * The four an ATS always asks for, and everything else optional.
 *
 * The split mirrors `mac-client/mac_client/profile.py`'s REQUIRED_FIELDS on
 * purpose: two validators disagreeing about what a usable profile is would mean
 * the client refuses a file `/profile` just called valid.
 */
export const applyProfileSchema = z.object({
  first_name: z.string().trim().min(1),
  last_name: z.string().trim().min(1),
  email: z.string().trim().email(),
  phone: z.string().trim().min(1),
  linkedin: z.string().trim().optional(),
  website: z.string().trim().optional(),
  default_resume: z.string().trim().optional(),
  resumes: z.record(z.string()).optional(),
  answers: answersSchema.optional(),
}).passthrough();

export type ApplyProfile = z.infer<typeof applyProfileSchema>;

/**
 * Where the profile lives.
 *
 * Beside the CVs under the same data root, because they are the same kind of
 * thing — durable founder-owned inputs that survive a deploy. `/opt/founderos`
 * is replaced wholesale on every deploy; `/opt/founderos-data` is not.
 */
export const APPLY_PROFILE_PATH =
  process.env["APPLY_PROFILE_PATH"]?.trim() ||
  join(process.env["FOUNDEROS_DATA_ROOT"]?.trim() || "/opt/founderos-data", "apply-profile.json");

/**
 * Where THIS candidate's apply profile lives.
 *
 * The default profile keeps the exact original path — `APPLY_PROFILE_PATH` is
 * also an env var override, and changing what it resolves to for the one
 * candidate every existing install already points at would silently orphan
 * their real file. Any OTHER profile gets its own sibling file in the same
 * directory, named by id, so a second candidate never reads or writes the
 * first one's name, email or resume paths.
 */
export function applyProfilePathFor(profileId: string): string {
  if (profileId === DEFAULT_PROFILE_ID) return APPLY_PROFILE_PATH;
  return join(dirname(APPLY_PROFILE_PATH), `apply-profile-${profileId}.json`);
}

export type ProfileRead =
  | { readonly ok: true; readonly profile: ApplyProfile; readonly raw: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse a profile, naming EVERY problem at once.
 *
 * One field per round trip is a bad trade when the round trip is a Telegram
 * message the founder reads on a phone: he wants the whole list, fixes it once,
 * and is done.
 */
export function parseApplyProfile(text: string): ProfileRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `not valid JSON — ${(err as Error).message}` };
  }

  const parsed = applyProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason: problems };
  }
  return { ok: true, profile: parsed.data, raw: raw as Record<string, unknown> };
}

/** Keys that are structure rather than answers, so `/profile` does not print them. */
const HIDDEN_KEYS = new Set(["_source", "_answers_note", "resumes"]);

/**
 * The profile as the founder reads it, with the fields that are NOT set called
 * out by name.
 *
 * Absences are the point. A profile view that lists only what is present cannot
 * tell him why a form came back with six blanks — and "six blanks" is the state
 * this whole file exists to make visible rather than mysterious.
 */
export function renderApplyProfile(profile: ApplyProfile): string {
  const line = (label: string, value: unknown): string =>
    value === undefined || value === null || value === ""
      ? `• <b>${label}</b>: <i>not set</i>`
      : `• <b>${label}</b>: ${String(value)}`;

  const a = profile.answers ?? {};
  const resumeCount = Object.keys(profile.resumes ?? {}).length;

  return [
    "<b>Apply profile</b> — what every form gets filled from.",
    "",
    line("Name", `${profile.first_name} ${profile.last_name}`),
    line("Email", profile.email),
    line("Phone", profile.phone),
    line("LinkedIn", profile.linkedin),
    line("Website", profile.website),
    "",
    line("Lives in", [a.location_city, a.location_country].filter(Boolean).join(", ")),
    line("Right to work", a.work_authorization ?? "unknown"),
    line("Salary floor", a.salary_floor_eur_year ? `€${a.salary_floor_eur_year.toLocaleString()}/yr` : undefined),
    line("Years experience", a.years_experience),
    line("Notice period", a.notice_period_days === undefined ? undefined : `${a.notice_period_days} days`),
    "",
    line("CVs on file", resumeCount > 0 ? `${resumeCount} track CVs + a default` : undefined),
    "",
    a.work_authorization === "unknown" || a.work_authorization === undefined
      ? "⚠ <b>Right to work is not set</b>, so every form's work-authorisation question is left blank for you. That is deliberate — a guessed answer there is a false statement, not a typo."
      : "<i>Work-authorisation questions are answered from “Right to work” above. Change it and every future form follows.</i>",
    "",
    "Edit one field: <code>/profile set phone +31 6 12345678</code>",
    "Nested: <code>/profile set answers.years_experience 4</code>",
  ].join("\n");
}

/**
 * Apply one dotted-path edit to a parsed JSON object, immutably.
 *
 * Returns a NEW object rather than mutating: the caller re-validates the result
 * before writing, and a mutation would leave the in-memory copy changed even
 * when validation rejects it.
 *
 * Numbers and booleans are coerced, because a Telegram message is always a
 * string and `years_experience: "4"` fails the schema for a reason nobody
 * reading the message would guess.
 */
export function setProfileField(
  raw: Record<string, unknown>,
  path: string,
  value: string,
): { ok: true; next: Record<string, unknown> } | { ok: false; reason: string } {
  const parts = path.split(".").filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 2) {
    return { ok: false, reason: "use a field name, or section.field — nothing deeper" };
  }
  if (HIDDEN_KEYS.has(parts[0]!)) {
    return { ok: false, reason: `${parts[0]} is not editable from Telegram` };
  }

  const coerced: unknown =
    value === "true" ? true
    : value === "false" ? false
    : /^-?\d+(\.\d+)?$/.test(value) ? Number(value)
    : value;

  const next = { ...raw };
  if (parts.length === 1) {
    next[parts[0]!] = coerced;
  } else {
    const section = next[parts[0]!];
    next[parts[0]!] = {
      ...(typeof section === "object" && section !== null ? (section as Record<string, unknown>) : {}),
      [parts[1]!]: coerced,
    };
  }
  return { ok: true, next };
}

/** Read the profile off disk. A missing file is a REASON, never an empty profile. */
export async function readApplyProfile(path: string = APPLY_PROFILE_PATH): Promise<ProfileRead> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      reason:
        e.code === "ENOENT"
          ? `no profile at ${path} yet`
          : `could not read ${path} — ${e.message}`,
    };
  }
  return parseApplyProfile(text);
}

/**
 * Write the profile, 0600.
 *
 * It carries a real name, email and phone number, and it sits on a box with
 * other services on it. `chmod` is applied through the open mode rather than
 * afterwards so the file is never briefly world-readable.
 */
export async function writeApplyProfile(
  raw: Record<string, unknown>,
  path: string = APPLY_PROFILE_PATH,
): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}
