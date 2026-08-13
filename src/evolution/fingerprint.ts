/**
 * M0a — Evolution Engine v0: finding fingerprint.
 * ==================================================
 * A stable identity hash for a `Finding`, so the same defect maps to the same
 * row across runs (src/evolution/persist-findings.ts) instead of spawning a
 * fresh one every audit.
 *
 * ## What goes into the hash, and why
 *
 * `kind + location + subject` — deliberately NOT `evidence`.
 *
 * The remediation brief for this table specified the hash as
 * "kind + location + normalised detail", modeled on
 * `normalizeFailureSignature` (src/kernel/lessons.ts) hashing a normalized
 * `FailureReport.message`. `Finding` (src/evolution/types.ts) has no
 * `detail`/`message` field, only `evidence` — a full sentence an analyzer
 * composes fresh every run. Every analyzer in src/evolution/analyzers/
 * embeds volatile numbers straight into that sentence: a dollar amount and a
 * percentage (`findCostHotspots`), a distinct-signature count
 * (`findRecurringFailures`), a times-seen count (`findUnappliedLessons`), a
 * line count and headroom (`findFilesNearLocBudget`). None of those numbers
 * changing means the underlying defect changed — hashing `evidence` would
 * fracture one persistent finding into a new row on nearly every run, which
 * is the exact failure this table exists to prevent.
 *
 * `subject` stands in for "detail" instead: every analyzer's `subject` is
 * already its structured identity for one finding (a symbol name, a module
 * path, a package name, an `agent:model` key, a `worker:signature` key) and,
 * verified against every analyzer in src/evolution/analyzers/, is unique
 * within that analyzer's own output for a given run. `location` alone is not
 * enough — it collides for `unused-dependency` findings (never set) and for
 * multiple `dead-export` findings in the same file. `kind` alone is not
 * enough either: `findOrphanModules` and `findOrphanSubsystems` both emit
 * kind `"orphan-module"` for different subjects.
 *
 * This is a correction of the brief's literal wording, not a different
 * design — the same goal ("cosmetic wording changes don't create a new
 * finding") is better served by excluding the free-text sentence entirely
 * than by trying to normalize volatile numbers out of prose, which
 * `normalizeFailureSignature` can do because error messages share a handful
 * of shapes (uuids, hashes, urls) while `Finding.evidence` sentences do not.
 *
 * `normalizeIdentityPart` below still does real work: it collapses
 * whitespace and a trailing slash so `"src/dir/ "` and `"src/dir"` fingerprint
 * identically, which is the genuinely cosmetic variance this shape of field
 * can carry.
 */

import { createHash } from "node:crypto";
import type { Finding } from "./types.js";

/** Separator that cannot appear inside a kind/location/subject value. */
const FIELD_SEPARATOR = "";

/** Collapse whitespace and a trailing slash — the only cosmetic noise these fields carry. */
export function normalizeIdentityPart(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/\/+$/, "");
}

/**
 * Deterministic identity hash for a finding. Pure — same input, same output,
 * every time, on any machine (sha256 over a fixed-format string).
 */
export function computeFingerprint(finding: Pick<Finding, "kind" | "subject" | "location">): string {
  const parts = [
    finding.kind,
    normalizeIdentityPart(finding.location ?? ""),
    normalizeIdentityPart(finding.subject),
  ];
  return createHash("sha256").update(parts.join(FIELD_SEPARATOR)).digest("hex");
}
