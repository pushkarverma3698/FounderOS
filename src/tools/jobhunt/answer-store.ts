/**
 * FounderOS — answer store
 * ========================
 * The one safe way to change a candidate saved application answers. They live in two files
 * (apply-profile-ID.json and candidate-dossier-ID.md); this module writes them together, atomically,
 * after a timestamped backup, and keeps the dossier Core Facts in step with answers.* (SEMANTIC_RULES read
 * the dossier first, so a profile-only edit used to change nothing a form saw).
 *
 * Backups sit beside the profile (the data root in prod: /opt/founderos-data/answer-backups/PROFILE_ID/),
 * newest 30 kept, mode 0600.
 */

import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncCoreFacts } from "./answer-core-facts.js";
import { atomicWrite, atomicWriteMany, withKeyLock } from "./atomic-write.js";
import {
  APPLY_PROFILE_PATH,
  applyProfilePathFor,
  parseApplyProfile,
  readApplyProfile,
  setProfileField,
  type ApplyProfile,
} from "./apply-profile.js";
import {
  BOLD_KV,
  buildDefaultDossierMarkdown,
  candidateDossierPathFor,
  normalizeQuestionKey,
} from "./candidate-dossier.js";
import { selfIdCategoryOf } from "./self-identification.js";

export { atomicWrite, atomicWriteMany };

export const BACKUPS_KEPT = 30;
/** recordLearnedAnswer fires on every form fill; back up at most this often so it cannot evict the older pairs. */
export const LEARNED_BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000;

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const LEARNED_HEADING = "## Learned Form Answers";

export interface AnswerState {
  readonly profile: Record<string, unknown>;
  readonly dossierMarkdown: string;
}
export interface Reject {
  readonly reject: string;
}
/** A mutation returns the new state, a Reject to refuse, or null for "nothing to change". */
export type Mutation = (state: AnswerState) => AnswerState | Reject | null;
export type SaveResult =
  | { readonly ok: true; readonly changed: boolean; readonly profile?: ApplyProfile; readonly dossierMarkdown?: string }
  | { readonly ok: false; readonly reason: string };
export interface SaveOptions {
  readonly backup?: boolean;
  readonly backupMinIntervalMs?: number;
}
export interface AnswerBackup {
  readonly ts: string;
  readonly json: boolean;
  readonly md: boolean;
}
export interface LearnedAnswer {
  readonly question: string;
  readonly answer: string;
  readonly source: "question_bank" | "dossier" | "both";
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/* backups */

function backupDirFor(profileId: string): string {
  if (!SAFE_ID.test(profileId)) throw new Error(`unsafe profile id: ${profileId}`);
  const base = process.env["APPLY_PROFILE_PATH"]?.trim() || APPLY_PROFILE_PATH;
  return join(dirname(base), "answer-backups", profileId);
}

const tsOf = (d: Date): string => d.toISOString().replace(/[:.]/g, "-");
const dateOf = (ts: string): number =>
  Date.parse(ts.replace(/^(.*T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z"));

/** Backups for this profile, newest first. */
export async function listAnswerBackups(profileId: string): Promise<AnswerBackup[]> {
  const names = await fs
    .readdir(backupDirFor(profileId))
    // allow-failopen: no backup directory yet just means no backups.
    .catch(() => [] as string[]);
  const byTs = new Map<string, { json: boolean; md: boolean }>();
  for (const name of names) {
    const m = /^(.+)\.(json|md)$/.exec(name);
    if (!m || !TS_RE.test(m[1]!)) continue;
    const e = byTs.get(m[1]!) ?? { json: false, md: false };
    if (m[2] === "json") e.json = true;
    else e.md = true;
    byTs.set(m[1]!, e);
  }
  return [...byTs.entries()].map(([ts, e]) => ({ ts, ...e })).sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

// allow-failopen: a file that does not exist yet is simply not part of the backup.
const readOrNull = (p: string): Promise<string | null> => fs.readFile(p, "utf8").catch(() => null);

/** Copy both answer files to a new timestamped pair and keep the newest 30. Returns the timestamp, or null when skipped. */
export async function backupAnswerFiles(
  profileId: string,
  opts: { readonly minIntervalMs?: number } = {},
): Promise<string | null> {
  const dir = backupDirFor(profileId);
  const existing = await listAnswerBackups(profileId);
  const newest = existing[0];
  if (opts.minIntervalMs && newest && Date.now() - dateOf(newest.ts) < opts.minIntervalMs) return null;

  const [json, md] = await Promise.all([
    readOrNull(applyProfilePathFor(profileId)),
    readOrNull(candidateDossierPathFor(profileId)),
  ]);
  if (json === null && md === null) return null;

  // Two backups in the same millisecond (or a clock step back) must not overwrite each other.
  let when = new Date();
  if (newest && tsOf(when) <= newest.ts) when = new Date(dateOf(newest.ts) + 1);
  const ts = tsOf(when);
  const files = [
    ...(json !== null ? [{ path: join(dir, `${ts}.json`), content: json }] : []),
    ...(md !== null ? [{ path: join(dir, `${ts}.md`), content: md }] : []),
  ];
  await atomicWriteMany(files);

  const all = [ts, ...existing.map((b) => b.ts)];
  for (const old of all.slice(BACKUPS_KEPT)) {
    await Promise.all([
      // allow-failopen: pruning an old backup is best effort; the new pair is already safe.
      fs.rm(join(dir, `${old}.json`), { force: true }).catch(() => undefined),
      // allow-failopen: same.
      fs.rm(join(dir, `${old}.md`), { force: true }).catch(() => undefined),
    ]);
  }
  return ts;
}

/** Put a backup pair back. The profile JSON is validated first; the current files are backed up before they are replaced. */
async function restoreUnlocked(
  profileId: string,
  ts: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  if (!TS_RE.test(ts)) return { ok: false, reason: `not a backup timestamp: ${ts}` };
  const dir = backupDirFor(profileId);
  const json = await readOrNull(join(dir, `${ts}.json`));
  if (json === null) return { ok: false, reason: `no profile backup at ${ts}` };
  const parsed = parseApplyProfile(json);
  if (!parsed.ok) return { ok: false, reason: `backup ${ts} is not a valid profile: ${parsed.reason}` };
  const md = await readOrNull(join(dir, `${ts}.md`));

  await backupAnswerFiles(profileId);
  await atomicWriteMany([
    { path: applyProfilePathFor(profileId), content: json },
    ...(md !== null ? [{ path: candidateDossierPathFor(profileId), content: md }] : []),
  ]);
  return { ok: true };
}

/* dossier Learned Form Answers */

/** markdown with a bold question and answer line last in Learned Form Answers and no older line for that question. */
export function withLearnedLine(markdown: string, question: string, answer: string): string {
  const line = `- **${question}**: ${answer}`;
  const lines = markdown.trimEnd().split("\n");
  const start = lines.findIndex((l) => l.trim() === LEARNED_HEADING);
  if (start === -1) return `${markdown.trimEnd()}\n\n${LEARNED_HEADING}\n${line}\n`;
  const normQ = normalizeQuestionKey(question);
  const kept = lines.filter((l, i) => {
    const m = i > start && normQ ? BOLD_KV.exec(l.trim()) : null;
    return !m || normalizeQuestionKey(m[1]!) !== normQ;
  });
  return `${kept.join("\n")}\n${line}\n`;
}

/** markdown without any Learned Form Answers line for this question. */
export function withoutLearnedLine(markdown: string, question: string): string {
  const normQ = normalizeQuestionKey(question);
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === LEARNED_HEADING);
  if (start === -1 || !normQ) return markdown;
  return lines
    .filter((l, i) => {
      const m = i > start ? BOLD_KV.exec(l.trim()) : null;
      return !m || normalizeQuestionKey(m[1]!) !== normQ;
    })
    .join("\n");
}

function learnedLines(markdown: string): Array<{ question: string; answer: string }> {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === LEARNED_HEADING);
  if (start === -1) return [];
  const out: Array<{ question: string; answer: string }> = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(l.trim())) break;
    const m = BOLD_KV.exec(l.trim());
    if (m) out.push({ question: m[1]!.trim(), answer: m[2]!.trim() });
  }
  return out;
}

/* the one entry point */

/**
 * Back up, apply mutate to the profile JSON and the dossier markdown, validate the profile, sync Core Facts,
 * and write both files atomically. Refuses (writes nothing) when the profile is unreadable or the result is invalid.
 */
async function saveAnswersUnlocked(profileId: string, mutate: Mutation, opts: SaveOptions = {}): Promise<SaveResult> {
  const profilePath = applyProfilePathFor(profileId);
  const dossierPath = candidateDossierPathFor(profileId);
  const current = await readApplyProfile(profilePath);
  if (!current.ok) return { ok: false, reason: current.reason };
  const existingMd = (await readOrNull(dossierPath)) ?? buildDefaultDossierMarkdown(current.profile);

  const out = mutate({ profile: current.raw, dossierMarkdown: existingMd });
  if (out === null) return { ok: true, changed: false };
  if ("reject" in out) return { ok: false, reason: out.reject };

  const parsed = parseApplyProfile(JSON.stringify(out.profile));
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  if (opts.backup !== false) await backupAnswerFiles(profileId, { minIntervalMs: opts.backupMinIntervalMs });

  const md = syncCoreFacts(out.dossierMarkdown, current.raw, out.profile);
  await atomicWriteMany([
    { path: profilePath, content: `${JSON.stringify(out.profile, null, 2)}\n` },
    { path: dossierPath, content: md.endsWith("\n") ? md : `${md}\n` },
  ]);
  return { ok: true, changed: true, profile: parsed.profile, dossierMarkdown: md };
}

/* editor operations */

/** Set one dotted path (phone, answers.salary_floor_eur_year, ...), coercing numbers and booleans. */
export function setProfilePath(profileId: string, path: string, value: string, opts?: SaveOptions): Promise<SaveResult> {
  return saveAnswers(
    profileId,
    (s) => {
      const edited = setProfileField(s.profile, path, value);
      return edited.ok ? { profile: edited.next, dossierMarkdown: s.dossierMarkdown } : { reject: edited.reason };
    },
    opts,
  );
}

/** Set one answers.* field; the matching Core Facts line follows. */
export function setCoreAnswer(profileId: string, field: string, value: string, opts?: SaveOptions): Promise<SaveResult> {
  return setProfilePath(profileId, `answers.${field}`, value, opts);
}

/** Record or replace a learned answer: older spellings go, the newest is last, EEO answers set self_identification. */
export function upsertLearnedAnswer(
  profileId: string,
  question: string,
  answer: string,
  opts?: SaveOptions,
): Promise<SaveResult> {
  const q = question.trim();
  const a = answer.trim();
  if (!q || !a) return Promise.resolve({ ok: false, reason: "a question and an answer are both needed" });
  const normQ = normalizeQuestionKey(q);
  return saveAnswers(
    profileId,
    (s) => {
      const bank = Object.fromEntries(
        Object.entries(asRecord(s.profile["question_bank"])).filter(([k]) => !normQ || normalizeQuestionKey(k) !== normQ),
      );
      const category = selfIdCategoryOf(q);
      const cur = asRecord(s.profile["answers"]);
      const selfId = category ? { answers: { ...cur, self_identification: { ...asRecord(cur["self_identification"]), [category]: a } } } : {};
      return {
        profile: { ...s.profile, ...selfId, question_bank: { ...bank, [q]: a } },
        dossierMarkdown: withLearnedLine(s.dossierMarkdown, q, a),
      };
    },
    opts,
  );
}

/** Remove a learned answer from question_bank AND the dossier Learned Form Answers. changed is false when it was in neither. */
export function deleteLearnedAnswer(profileId: string, question: string, opts?: SaveOptions): Promise<SaveResult> {
  const normQ = normalizeQuestionKey(question);
  return saveAnswers(
    profileId,
    (s) => {
      if (!normQ) return null;
      const bank = asRecord(s.profile["question_bank"]);
      const kept = Object.fromEntries(Object.entries(bank).filter(([k]) => normalizeQuestionKey(k) !== normQ));
      const md = withoutLearnedLine(s.dossierMarkdown, question);
      if (Object.keys(kept).length === Object.keys(bank).length && md === s.dossierMarkdown) return null;
      return { profile: { ...s.profile, question_bank: kept }, dossierMarkdown: md };
    },
    opts,
  );
}

/** question_bank and the dossier Learned Form Answers merged; the bank wins on a clash (explicitAnswerFor reads it first). */
export async function listLearnedAnswers(profileId: string): Promise<LearnedAnswer[]> {
  const current = await readApplyProfile(applyProfilePathFor(profileId));
  const md = await readOrNull(candidateDossierPathFor(profileId));
  const merged = new Map<string, LearnedAnswer>();
  for (const l of md ? learnedLines(md) : []) {
    merged.set(normalizeQuestionKey(l.question) || l.question, { ...l, source: "dossier" });
  }
  const bank = current.ok ? asRecord(current.raw["question_bank"]) : {};
  for (const [q, v] of Object.entries(bank)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const key = normalizeQuestionKey(q) || q;
    const inDossier = merged.has(key);
    merged.delete(key);
    merged.set(key, { question: q, answer: v.trim(), source: inDossier ? "both" : "question_bank" });
  }
  return [...merged.values()];
}

/**
 * Learn an answer during a form fill. Same result as upsertLearnedAnswer, backed up at most every 10 minutes,
 * and an unreadable profile still gets the dossier line (as before).
 */
export async function recordLearnedAnswer(profileId: string, question: string, answer: string): Promise<void> {
  const q = question.trim();
  const a = answer.trim();
  if (!q || !a) return;
  const saved = await upsertLearnedAnswer(profileId, q, a, { backupMinIntervalMs: LEARNED_BACKUP_MIN_INTERVAL_MS });
  if (saved.ok) return;
  const dossierPath = candidateDossierPathFor(profileId);
  const existing = (await readOrNull(dossierPath)) ?? `# Candidate Reference Dossier (${profileId})\n\n${LEARNED_HEADING}\n`;
  await atomicWrite(dossierPath, withLearnedLine(existing, q, a));
}

/** Serialized per profile so overlapping saves (bot reply, answer page, editor) never read the same old state. */
export function saveAnswers(profileId: string, mutate: Mutation, opts: SaveOptions = {}): Promise<SaveResult> {
  return withKeyLock(profileId, () => saveAnswersUnlocked(profileId, mutate, opts));
}

export function restoreAnswerBackup(
  profileId: string,
  ts: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  return withKeyLock(profileId, () => restoreUnlocked(profileId, ts));
}
