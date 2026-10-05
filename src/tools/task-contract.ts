/**
 * FounderOS — TaskContract
 * ========================
 * The typed spec a one-line founder ask is turned into before any code is written.
 *
 * WHY. A /task issue used to say "verification = repo's own checks" and "paths: agent to
 * locate" (PRs #895/#899). The reviewer then had nothing to check except green CI. The contract
 * makes the ask checkable: current behavior cited as `path:line@sha`, a locked test, a bounded
 * scope, hard size limits. Design: docs/plans/2026-09-30-coding-pipeline-v2.md section 4 and
 * docs/plans/2026-10-05-coding-pipeline-thin-slice.md section 4.
 *
 * Shape only. Whether the citations are real, whether scope touches CI, and what risk the
 * paths imply are decided by the pure spec gate (spec-gate.ts), not here and not by a model.
 * `ask` is the founder's verbatim words and is inserted by code, never written by a model.
 */
import { z } from "zod";

const SHA_MESSAGE = "must be a full 40-character lowercase hex commit sha";
const Sha = z.string().regex(/^[0-9a-f]{40}$/, SHA_MESSAGE);

const NonBlank = (what: string) =>
  z.string().refine((s) => s.trim().length > 0, { message: `${what} must not be blank` });

const PositiveInt = (what: string) =>
  z
    .number({ invalid_type_error: `${what} must be a positive whole number` })
    .int(`${what} must be a whole number`)
    .positive(`${what} must be greater than zero`);

export const TASK_TYPES = ["bugfix", "feature", "refactor"] as const;
export const RISKS = ["low", "medium", "high"] as const;

export const CitationSchema = z
  .object({
    path: NonBlank("citation path"),
    line: PositiveInt("citation line"),
    sha: Sha,
  })
  .strict();

const PredicateSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const OracleSchema = z
  .object({
    id: NonBlank("oracle id"),
    kind: z.enum(["http", "telegram", "unit-only"]),
    target: z.string().optional(),
    before: PredicateSchema,
    expected_after: PredicateSchema,
  })
  .strict();

export const TaskLimitsSchema = z
  .object({
    files: PositiveInt("limits.files"),
    lines: PositiveInt("limits.lines"),
    deleted_lines: PositiveInt("limits.deleted_lines"),
    new_dependencies: z.literal(false, {
      errorMap: () => ({ message: "new_dependencies must be false: a task may not add a dependency" }),
    }),
  })
  .strict();

export const TaskContractSchema = z
  .object({
    version: z.literal(1),
    ask: NonBlank("ask"),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must look like owner/name"),
    task_type: z.enum(TASK_TYPES),
    base_sha: Sha,
    current_behavior: z
      .object({
        text: NonBlank("current_behavior.text"),
        citations: z
          .array(CitationSchema)
          .min(1, "at least one citation (path:line@sha) is required: no citable code, no spec"),
      })
      .strict(),
    expected_behavior: NonBlank("expected_behavior"),
    scope: z.array(z.string()),
    locked_tests: z.array(z.string()).min(1, "at least one locked test is required"),
    oracle: OracleSchema,
    risk: z.enum(RISKS),
    limits: TaskLimitsSchema,
    spec_commit: Sha.optional(),
  })
  .strict();

export type TaskType = (typeof TASK_TYPES)[number];
export type Risk = (typeof RISKS)[number];
export type Citation = z.infer<typeof CitationSchema>;
export type Oracle = z.infer<typeof OracleSchema>;
export type TaskLimits = z.infer<typeof TaskLimitsSchema>;
export type TaskContract = z.infer<typeof TaskContractSchema>;

export type ParseTaskContractResult =
  | { ok: true; contract: TaskContract }
  | { ok: false; errors: string[] };

/** Validate untrusted input. Every problem is reported, each prefixed with its field path. */
export function parseTaskContract(raw: unknown): ParseTaskContractResult {
  const r = TaskContractSchema.safeParse(raw);
  if (r.success) return { ok: true, contract: r.data };
  const errors = r.error.issues.map((i) => {
    const where = i.path.length > 0 ? i.path.join(".") : "contract";
    return `${where}: ${i.message}`;
  });
  return { ok: false, errors };
}

/** `path:line@sha7`, the form a founder and a reviewer read. */
export function renderCitation(c: Citation): string {
  return `${c.path}:${c.line}@${c.sha.slice(0, 7)}`;
}
