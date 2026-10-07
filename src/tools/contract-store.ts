/**
 * FounderOS - contract store
 * ==========================
 * One JSON file per approved task, so the PR evidence CLI can read the contract the founder
 * approved instead of trusting anything a PR says about itself. Dir = FOUNDEROS_CONTRACTS_DIR,
 * default /var/lib/founderos/contracts. File = <owner>__<name>__<issue>.json, lowercased: GitHub
 * names are case-insensitive, and callers spell the same repo differently (Pass P "owner/FounderOS",
 * pr-brain "owner/founderos" from its checkout dir).
 *
 * Rules: fs is injected (no module-level I/O); writes are atomic (tmp file, then rename); a write
 * never replaces a record with a different fingerprint, never loosens an approved contract, and
 * never overwrites a file it cannot read; reads are Zod-validated and an invalid file is an
 * error value, never a partial contract. Nothing here throws on bad data or a failing fs.
 *
 * Not safe against two writers racing on the same task (read, compare, rename is not a lock).
 * One writer per task is the design: the founder approval path.
 */

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { TaskContractSchema } from "./task-contract.js";

export const DEFAULT_CONTRACTS_DIR = "/var/lib/founderos/contracts";

const REPO_RE = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;
const Sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-character lowercase hex sha");

export const ContractRecordSchema = z
  .object({
    version: z.literal(1),
    repo: z.string().regex(REPO_RE, "must look like owner/name"),
    issue: z.number().int().positive(),
    contract: TaskContractSchema,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"),
    approved_at: z.string().datetime(),
    approved_by: z.enum(["founder", "auto"]),
    spec_commit: Sha.optional(),
    pr: z.number().int().positive().optional(),
    merged_sha: Sha.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.contract.repo !== r.repo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract", "repo"], message: "contract.repo must equal the record repo" });
    }
    if (r.spec_commit && r.contract.spec_commit && r.spec_commit !== r.contract.spec_commit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spec_commit"], message: "spec_commit must equal contract.spec_commit" });
    }
  });

export type ContractRecord = z.infer<typeof ContractRecordSchema>;

export interface StoreFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
  rm(path: string): Promise<void>;
}

export type StoreErrorCode = "not_found" | "invalid" | "conflict" | "io" | "bad_key";
export type StoreResult<T> = { ok: true; value: T } | { ok: false; code: StoreErrorCode; error: string };

const fail = (code: StoreErrorCode, error: string): { ok: false; code: StoreErrorCode; error: string } => ({ ok: false, code, error });

export function contractsDir(env: Record<string, string | undefined>): string {
  const d = env.FOUNDEROS_CONTRACTS_DIR?.trim();
  return d ? d : DEFAULT_CONTRACTS_DIR;
}

/** A/b + 12 -> a__b__12.json. Refuses anything that is not a plain owner/name and a positive integer. */
export function contractFileName(repo: string, issue: number): StoreResult<string> {
  const exact = exactFileName(repo, issue);
  return exact.ok ? { ok: true, value: exact.value.toLowerCase() } : exact;
}

/** The case-sensitive name records were stored under before 2026-10-07. Read-only fallback. */
function exactFileName(repo: string, issue: number): StoreResult<string> {
  if (!REPO_RE.test(repo)) return fail("bad_key", "repo must look like owner/name, got " + JSON.stringify(repo));
  if (!Number.isInteger(issue) || issue <= 0) return fail("bad_key", "issue must be a positive integer, got " + String(issue));
  const [owner, name] = repo.split("/") as [string, string];
  return { ok: true, value: owner + "__" + name + "__" + issue + ".json" };
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function issuesOf(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message)
    .join("; ");
}

export async function readContractRecord(fs: StoreFs, dir: string, repo: string, issue: number): Promise<StoreResult<ContractRecord>> {
  const name = contractFileName(repo, issue);
  if (!name.ok) return name;
  const found = await readFile(fs, posix.join(dir, name.value), repo, issue);
  const legacy = exactFileName(repo, issue);
  if (found.ok || found.code !== "not_found" || !legacy.ok || legacy.value === name.value) return found;
  return readFile(fs, posix.join(dir, legacy.value), repo, issue);
}

async function readFile(fs: StoreFs, file: string, repo: string, issue: number): Promise<StoreResult<ContractRecord>> {
  let text: string;
  try {
    text = await fs.readFile(file);
  } catch (err) {
    if (errCode(err) === "ENOENT") return fail("not_found", "no contract stored at " + file);
    return fail("io", "cannot read " + file + ": " + errMessage(err));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail("invalid", file + " is not valid JSON: " + errMessage(err));
  }
  const p = ContractRecordSchema.safeParse(raw);
  if (!p.success) return fail("invalid", file + " is not a valid contract record: " + issuesOf(p.error));
  if (p.data.repo.toLowerCase() !== repo.toLowerCase() || p.data.issue !== issue) {
    return fail("invalid", file + " holds " + p.data.repo + "#" + p.data.issue + ", not " + repo + "#" + issue);
  }
  return { ok: true, value: p.data };
}

/** Key-order independent JSON, so two records that mean the same thing compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

/** Fields that are filled in later, once. Everything else in a record is frozen at approval. */
const SET_ONCE = ["spec_commit", "pr", "merged_sha"] as const;

function frozenView(r: ContractRecord): string {
  const { spec_commit: _s, pr: _p, merged_sha: _m, contract, ...rest } = r;
  const { spec_commit: _cs, ...frozenContract } = contract;
  return canonical({ ...rest, contract: frozenContract });
}

/** Why `next` may not replace `existing`, or null. Same fingerprint is necessary, not sufficient. */
function conflictWith(existing: ContractRecord, next: ContractRecord): string | null {
  if (existing.fingerprint !== next.fingerprint) {
    return "a different contract (fingerprint " + existing.fingerprint.slice(0, 12) + ") is already approved for this task";
  }
  if (frozenView(existing) !== frozenView(next)) {
    return "the approved contract, approval or limits would change under the same fingerprint";
  }
  for (const k of SET_ONCE) {
    if (existing[k] !== undefined && existing[k] !== next[k]) return k + " is already set and may not change";
  }
  if (existing.contract.spec_commit !== undefined && existing.contract.spec_commit !== next.contract.spec_commit) {
    return "contract.spec_commit is already set and may not change";
  }
  return null;
}

/**
 * Create the record, or fill in spec_commit / pr / merged_sha on an existing record with the same
 * approval. Returns the stored record. `newId` names the tmp file (injectable for tests).
 */
export async function writeContractRecord(
  fs: StoreFs,
  dir: string,
  record: ContractRecord,
  newId: () => string = randomUUID,
): Promise<StoreResult<ContractRecord>> {
  const parsed = ContractRecordSchema.safeParse(record);
  if (!parsed.success) return fail("invalid", "refusing to store an invalid contract record: " + issuesOf(parsed.error));
  const next = parsed.data;
  const name = contractFileName(next.repo, next.issue);
  if (!name.ok) return name;
  const file = posix.join(dir, name.value);

  const existing = await readContractRecord(fs, dir, next.repo, next.issue);
  if (existing.ok) {
    const why = conflictWith(existing.value, next);
    if (why) return fail("conflict", "refusing to overwrite " + file + ": " + why);
  } else if (existing.code !== "not_found") {
    return fail(existing.code, "refusing to overwrite " + file + ": " + existing.error);
  }

  const tmp = file + "." + newId() + ".tmp";
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
    await fs.rename(tmp, file);
  } catch (err) {
    try {
      await fs.rm(tmp);
    } catch {
      // the tmp file is only litter; the write error below is the one to report
    }
    return fail("io", "cannot write " + file + ": " + errMessage(err));
  }
  return { ok: true, value: next };
}
