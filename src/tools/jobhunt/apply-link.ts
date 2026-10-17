/**
 * Apply answer page: signed link + snapshot store
 * ===============================================
 * `/apply <rank>` fills an ATS form headlessly and used to send a screenshot. The answer page
 * replaces the screenshot with a phone-friendly page on the jobs health server. This module is
 * the part that decides WHO may open the page and WHAT the page shows:
 *
 *   - A link is `${APPLY_LINK_BASE_URL}/apply/<rowId>.<expUnix>.<sig>`. The signature is
 *     HMAC-SHA256(APPLY_LINK_SECRET, `${rowId}.${profileId}.${exp}`), base64url. The profile id is
 *     in the signed text but not in the URL; the server takes it from the stored snapshot, so a
 *     link minted for one candidate cannot open another candidate's page.
 *   - A snapshot is the last prepared state of that row (what the bot filled, what is still
 *     unanswered). It lives on disk under the data root, so it survives a deploy and a restart,
 *     is written 0600 through tmp + rename, and is pruned after seven days.
 *
 * Nothing here submits an application. Submit stays behind the Telegram tap.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataRoot } from "../../core/data-root.js";

/** A link stays valid for three days. */
export const APPLY_LINK_TTL_MS = 72 * 60 * 60 * 1000;
/** A snapshot older than a week is deleted the next time any snapshot is saved. */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MIN_SECRET_CHARS = 16;
const SNAPSHOT_DIR = "apply-pages";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_RE = /^[A-Za-z0-9_-]{16,128}$/;

export type ApplyLinkConfig =
  | { readonly ok: true; readonly secret: string; readonly baseUrl: string }
  | { readonly ok: false; readonly reason: string };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Read at call time (config.ts is at its line budget, and a test can move the env). A missing
 * variable returns the reason; the caller prints it in the Telegram card instead of hiding it.
 */
export function readApplyLinkConfig(env: Env = process.env): ApplyLinkConfig {
  const secret = env["APPLY_LINK_SECRET"]?.trim();
  if (!secret) return { ok: false, reason: "APPLY_LINK_SECRET not set" };
  const base = env["APPLY_LINK_BASE_URL"]?.trim();
  if (!base) return { ok: false, reason: "APPLY_LINK_BASE_URL not set" };
  if (secret.length < MIN_SECRET_CHARS) {
    return { ok: false, reason: `APPLY_LINK_SECRET must be at least ${MIN_SECRET_CHARS} characters` };
  }
  if (!/^https?:\/\/[^\s/]+/i.test(base)) {
    return { ok: false, reason: "APPLY_LINK_BASE_URL must be an http(s) URL" };
  }
  return { ok: true, secret, baseUrl: base.replace(/\/+$/, "") };
}

function mac(secret: string, rowId: string, profileId: string, exp: number): string {
  return createHmac("sha256", secret).update(`${rowId}.${profileId}.${exp}`).digest("base64url");
}

/** `<rowId>.<expUnix>.<sig>`. */
export function signApplyToken(secret: string, rowId: string, profileId: string, expUnix: number): string {
  return `${rowId}.${expUnix}.${mac(secret, rowId, profileId, expUnix)}`;
}

export interface ParsedApplyToken {
  readonly rowId: string;
  readonly exp: number;
  readonly sig: string;
}

/** Shape check only: three dot parts, a uuid, digits, a base64url signature. No crypto here. */
export function parseApplyToken(token: string): ParsedApplyToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rowId, expText, sig] = parts as [string, string, string];
  if (!UUID_RE.test(rowId) || !/^\d{1,12}$/.test(expText) || !SIG_RE.test(sig)) return null;
  return { rowId, exp: Number(expText), sig };
}

export type VerifyApplyResult =
  | { readonly ok: true; readonly rowId: string; readonly exp: number }
  | { readonly ok: false; readonly reason: "malformed" | "bad-signature" | "expired" };

/** Constant-time compare on equal-length digests. Expiry is reported only for a genuine signature. */
export function verifyApplyToken(secret: string, token: string, profileId: string, nowMs: number): VerifyApplyResult {
  const parsed = parseApplyToken(token);
  if (!parsed) return { ok: false, reason: "malformed" };
  const want = createHmac("sha256", secret).update(mac(secret, parsed.rowId, profileId, parsed.exp)).digest();
  const got = createHmac("sha256", secret).update(parsed.sig).digest();
  if (!timingSafeEqual(want, got)) return { ok: false, reason: "bad-signature" };
  if (parsed.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, rowId: parsed.rowId, exp: parsed.exp };
}

/** The absolute link for the Telegram card. */
export function buildApplyUrl(
  cfg: Extract<ApplyLinkConfig, { ok: true }>,
  rowId: string,
  profileId: string,
  nowMs: number = Date.now(),
): string {
  const exp = Math.floor((nowMs + APPLY_LINK_TTL_MS) / 1000);
  return `${cfg.baseUrl}/apply/${signApplyToken(cfg.secret, rowId, profileId, exp)}`;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

const unansweredSchema = z.object({
  label: z.string().min(1),
  required: z.boolean(),
  fieldType: z.string(),
  options: z.array(z.string()).optional(),
  /** What the founder answered this session when the form still came back unfilled (re-ask guard). */
  triedAnswer: z.string().optional(),
});

/** One field the bot filled, with the value it put there (see form-filled.ts). */
const filledSchema = z.object({
  label: z.string().min(1),
  value: z.string(),
  fieldType: z.string(),
  options: z.array(z.string()).optional(),
  editable: z.boolean(),
});

export const applySnapshotSchema = z.object({
  rowId: z.string().regex(UUID_RE),
  chatId: z.string().min(1),
  profileId: z.string().min(1),
  company: z.string(),
  title: z.string(),
  candidateName: z.string(),
  targetUrl: z.string(),
  platform: z.string(),
  resumePath: z.string(),
  /** The letter attached on this run; absent when none was produced (`coverLetterNote` says why). */
  coverLetter: z.object({ text: z.string(), pdfPath: z.string() }).optional(),
  coverLetterNote: z.string().optional(),
  summary: z.object({
    filled: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    hasCaptcha: z.boolean(),
    filledLabels: z.array(z.string()),
    /** Absent in snapshots saved before the page showed values: they load with an empty list. */
    filledAnswers: z.array(filledSchema).default([]),
    unanswered: z.array(unansweredSchema),
  }),
  /** Epoch ms of the prepare run that produced this snapshot. */
  createdAt: z.number(),
});

export type ApplySnapshot = z.infer<typeof applySnapshotSchema>;
export type ApplySnapshotQuestion = ApplySnapshot["summary"]["unanswered"][number];
export type ApplySnapshotFilled = ApplySnapshot["summary"]["filledAnswers"][number];

function snapshotDir(root: string): string {
  return path.join(root, SNAPSHOT_DIR);
}

function snapshotFile(rowId: string, root: string): string {
  return path.join(snapshotDir(root), `${rowId}.json`);
}

/** Atomic (tmp + rename), mode 0600, directory 0700. Throws on a row id that is not a uuid. */
export function saveApplySnapshot(snapshot: ApplySnapshot, root: string = dataRoot()): void {
  if (!UUID_RE.test(snapshot.rowId)) throw new Error("apply snapshot: invalid row id");
  fs.mkdirSync(snapshotDir(root), { recursive: true, mode: 0o700 });
  const file = snapshotFile(snapshot.rowId, root);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  fs.renameSync(tmp, file);
  pruneApplySnapshots(Date.now(), root);
}

/** Null for a missing, corrupt, wrong-shape or mismatched file, and for any id that is not a uuid. */
export function loadApplySnapshot(rowId: string, root: string = dataRoot()): ApplySnapshot | null {
  if (!UUID_RE.test(rowId)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(snapshotFile(rowId, root), "utf8");
  } catch {
    // allow-failopen: a missing snapshot is the normal answer for an unknown or expired link.
    return null;
  }
  try {
    const parsed = applySnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.rowId === rowId ? parsed.data : null;
  } catch {
    // allow-failopen: a corrupt file is treated as not found; the page answers 404, nothing leaks.
    return null;
  }
}

export function deleteApplySnapshot(rowId: string, root: string = dataRoot()): void {
  if (!UUID_RE.test(rowId)) return;
  fs.rmSync(snapshotFile(rowId, root), { force: true });
}

/** Removes snapshots (and abandoned tmp files) older than seven days. Returns how many it removed. */
export function pruneApplySnapshots(nowMs: number, root: string = dataRoot()): number {
  let names: string[];
  try {
    names = fs.readdirSync(snapshotDir(root));
  } catch {
    // allow-failopen: no directory yet means nothing to prune.
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
    const file = path.join(snapshotDir(root), name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs > SNAPSHOT_MAX_AGE_MS) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      // allow-failopen: another request removed the file between readdir and stat.
    }
  }
  return removed;
}
