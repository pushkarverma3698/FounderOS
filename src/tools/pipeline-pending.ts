/**
 * FounderOS - coding pipeline v2: flag, labels and pending records
 * ================================================================
 * The three things every wave-3 step shares, so the dispatcher, the gateway and the evidence job cannot
 * drift apart:
 *  - the AGENT_PIPELINE_V2 flag (exactly "1" is on),
 *  - the issue labels the flow moves through,
 *  - the pending record: what a Telegram card points at. The card carries only `cp:<action>:<nonce>`; the nonce
 *    names a file under <contracts dir>/pending/ that holds what the founder was shown. Tapping reads the file,
 *    never the callback data, so a forged or stale tap cannot change what is approved or merged.
 *
 * Three kinds: "spec" (a contract waiting for approval, written by Pass P), "merge" (evidence and review for one PR
 * head, written when the evidence card goes out) and "fix" (a PR pr-brain blocked, written when the blocked card goes out). A tap CLAIMS the record by renaming it, which is atomic: of two
 * taps (a double tap, or two deliveries of one tap) exactly one gets the record. A transient failure after the claim
 * calls releasePending so the founder can tap again; a finished action leaves the claimed file as its trace.
 *
 * fs is injected (StoreFs, as in contract-store.ts); nothing here throws on bad data or a failing fs.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { TaskContractSchema } from "./task-contract.js";
import type { StoreFs } from "./contract-store.js";

export const PIPELINE_V2_FLAG = "AGENT_PIPELINE_V2";

/** On only for exactly "1", the same reading scripts/pr-evidence.ts uses. */
export function pipelineV2Enabled(env: Record<string, string | undefined>): boolean {
  return env[PIPELINE_V2_FLAG] === "1";
}

/** Issue filed, waiting for Pass P to write the contract and the locked test. */
export const LABEL_SPEC = "agent:spec";
/** Contract written and sent as a spec card; waiting for the founder. */
export const LABEL_SPEC_REVIEW = "agent:spec-review";
/** Approved: the executor may claim it. Existing label, same meaning as before the pipeline. */
export const LABEL_READY = "agent:ready";

const Sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-character lowercase hex sha");
const NONCE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const Nonce = z.string().regex(NONCE_RE, "must match [A-Za-z0-9_-]{1,32}");
const Repo = z.string().regex(/^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/, "must look like owner/name");
const Iso = z.string().datetime();

export const PendingSpecSchema = z
  .object({
    kind: z.literal("spec"),
    nonce: Nonce,
    repo: Repo,
    issue: z.number().int().positive(),
    contract: TaskContractSchema,
    effective_risk: z.enum(["low", "medium", "high"]),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"),
    spec_commit: Sha,
    created_at: Iso,
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.contract.repo !== r.repo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract", "repo"], message: "contract.repo must equal the record repo" });
    }
    if (r.contract.spec_commit !== r.spec_commit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spec_commit"], message: "spec_commit must equal contract.spec_commit" });
    }
  });

export const PendingMergeSchema = z
  .object({
    kind: z.literal("merge"),
    nonce: Nonce,
    repo: Repo,
    issue: z.number().int().positive(),
    pr: z.number().int().positive(),
    evidence: z
      .object({ status: z.enum(["PASS", "FAIL", "UNKNOWN"]), reasons: z.array(z.string()), head_sha: Sha })
      .strict(),
    review: z.object({ decision: z.enum(["APPROVE", "REQUEST_CHANGES", "UNKNOWN"]), head_sha: Sha }).strict(),
    head_at_review: Sha,
    base_at_review: Sha,
    created_at: Iso,
  })
  .strict()
  .superRefine((r, ctx) => {
    for (const [path, sha] of [
      [["evidence", "head_sha"], r.evidence.head_sha],
      [["review", "head_sha"], r.review.head_sha],
    ] as const) {
      if (sha !== r.head_at_review) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "must equal head_at_review: the card describes one head" });
      }
    }
  });

/** A PR pr-brain blocked, for the head the founder was shown: what [Fix now] and [Close PR] act on. */
export const PendingFixSchema = z
  .object({
    kind: z.literal("fix"),
    nonce: Nonce,
    repo: Repo,
    pr: z.number().int().positive(),
    /** Absent when the PR's branch is not task/issue-N: there is nothing to dispatch, only Close PR is offered. */
    issue: z.number().int().positive().optional(),
    head: Sha,
    branch: z.string().min(1).max(200),
    blockers: z.number().int().positive(),
    created_at: Iso,
  })
  .strict();

export const PendingRecordSchema = z.union([PendingSpecSchema, PendingMergeSchema, PendingFixSchema]);

export type PendingSpec = z.infer<typeof PendingSpecSchema>;
export type PendingMerge = z.infer<typeof PendingMergeSchema>;
export type PendingFix = z.infer<typeof PendingFixSchema>;
export type PendingRecord = PendingSpec | PendingMerge | PendingFix;

export type PendingErrorCode = "not_found" | "invalid" | "exists" | "io" | "bad_key";
export type PendingResult<T> = { ok: true; value: T } | { ok: false; code: PendingErrorCode; error: string };

const fail = (code: PendingErrorCode, error: string): { ok: false; code: PendingErrorCode; error: string } => ({ ok: false, code, error });

/** 12 random bytes as 16 URL-safe characters: fits cp:merge_ack:<nonce> in Telegram's 64-byte callback limit. */
export function newNonce(): string {
  return randomBytes(12).toString("base64url");
}

/** <dir>/pending/<nonce>.json, or an error for a nonce that is not a plain token. */
export function pendingFileName(dir: string, nonce: string): PendingResult<string> {
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return fail("bad_key", "nonce must match [A-Za-z0-9_-]{1,32}");
  return { ok: true, value: posix.join(dir, "pending", nonce + ".json") };
}

const claimedName = (file: string): string => file + ".claimed";

const errCode = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function readFileAs(fs: StoreFs, file: string, nonce: string): Promise<PendingResult<PendingRecord>> {
  let text: string;
  try {
    text = await fs.readFile(file);
  } catch (err) {
    if (errCode(err) === "ENOENT") return fail("not_found", "no pending record at " + file);
    return fail("io", "cannot read " + file + ": " + errText(err));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail("invalid", file + " is not valid JSON: " + errText(err));
  }
  const p = PendingRecordSchema.safeParse(raw);
  if (!p.success) {
    const why = p.error.issues.slice(0, 3).map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message).join("; ");
    return fail("invalid", file + " is not a valid pending record: " + why);
  }
  if (p.data.nonce !== nonce) return fail("invalid", file + " holds nonce " + p.data.nonce + ", not " + nonce);
  return { ok: true, value: p.data };
}

/** The open record for a nonce. A claimed record is not open. */
export async function readPending(fs: StoreFs, dir: string, nonce: string): Promise<PendingResult<PendingRecord>> {
  const name = pendingFileName(dir, nonce);
  if (!name.ok) return name;
  return readFileAs(fs, name.value, nonce);
}

/** Create the record. Never replaces an existing nonce, open or claimed. */
export async function writePending(
  fs: StoreFs,
  dir: string,
  record: PendingRecord,
  newId: () => string = randomUUID,
): Promise<PendingResult<PendingRecord>> {
  const parsed = PendingRecordSchema.safeParse(record);
  if (!parsed.success) {
    const why = parsed.error.issues.slice(0, 3).map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message).join("; ");
    return fail("invalid", "refusing to store an invalid pending record: " + why);
  }
  const next = parsed.data;
  const name = pendingFileName(dir, next.nonce);
  if (!name.ok) return name;
  const file = name.value;
  for (const f of [file, claimedName(file)]) {
    try {
      await fs.readFile(f);
      return fail("exists", "a pending record for nonce " + next.nonce + " already exists");
    } catch (err) {
      if (errCode(err) !== "ENOENT") return fail("io", "cannot check " + f + ": " + errText(err));
    }
  }
  const tmp = file + "." + newId() + ".tmp";
  try {
    await fs.mkdir(posix.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
    await fs.rename(tmp, file);
  } catch (err) {
    try {
      await fs.rm(tmp);
    } catch {
      // the tmp file is litter; the write error below is the one to report
    }
    return fail("io", "cannot write " + file + ": " + errText(err));
  }
  return { ok: true, value: next };
}

/**
 * Take the record. The rename is the lock: only one caller's rename succeeds, the other sees not_found. A record
 * that fails validation is put back (so it is not lost) and reported as invalid.
 */
export async function claimPending(fs: StoreFs, dir: string, nonce: string): Promise<PendingResult<PendingRecord>> {
  const name = pendingFileName(dir, nonce);
  if (!name.ok) return name;
  const file = name.value;
  const claimed = claimedName(file);
  try {
    await fs.rename(file, claimed);
  } catch (err) {
    if (errCode(err) === "ENOENT") return fail("not_found", "no open pending record for nonce " + nonce + " (used, expired or never sent)");
    return fail("io", "cannot claim " + file + ": " + errText(err));
  }
  const read = await readFileAs(fs, claimed, nonce);
  if (!read.ok) {
    try {
      await fs.rename(claimed, file);
    } catch {
      // nothing more to do: the read error is the one to report
    }
  }
  return read;
}

/** Undo a claim after a failure that says nothing about the founder's decision, so the card works again. */
export async function releasePending(fs: StoreFs, dir: string, nonce: string): Promise<PendingResult<true>> {
  const name = pendingFileName(dir, nonce);
  if (!name.ok) return name;
  try {
    await fs.rename(claimedName(name.value), name.value);
  } catch (err) {
    if (errCode(err) === "ENOENT") return fail("not_found", "nothing claimed for nonce " + nonce);
    return fail("io", "cannot release " + name.value + ": " + errText(err));
  }
  return { ok: true, value: true };
}
