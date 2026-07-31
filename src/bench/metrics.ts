/**
 * Agent Reliability Benchmark — pure scoring functions
 * ====================================================
 * Ground truth is the code-recorded `ToolReceipt`, never an LLM judge: the grader
 * must not be able to hallucinate. Every function here is pure and unit-tested at
 * $0, because the benchmark's numbers are only worth as much as its scorer.
 *
 * FAIRNESS: these functions are applied identically to every arm. There are no
 * arm-specific branches anywhere in this file, and there must never be.
 */

import type { FailureReport, ToolReceipt } from "../kernel/contracts.js";

export type ArmId = "founderos" | "react" | "raw";

export interface ArmRun {
  readonly task_id: string;
  readonly arm: ArmId;
  /** Final natural-language reply shown to the user. */
  readonly reply: string;
  /** Receipts the harness recorded in code during this run. */
  readonly receipts: readonly ToolReceipt[];
  /** Stable hash of the produced plan, for determinism scoring. */
  readonly plan_hash: string;
  readonly usd: number;
  readonly ms: number;
}

// ── Action-claim detection ───────────────────────────────────────────────────

/**
 * Past-tense assertions that an external side effect has already happened,
 * mapped to the tool families that could legitimately back them.
 *
 * Deliberately lexical and deterministic. This produces false positives and
 * negatives — that is a stated threat to validity — but it is reproducible and
 * applied identically to all arms, so the *comparison* stays fair even where the
 * absolute rate is noisy.
 */
export const ACTION_CLAIM_LEXICON: ReadonlyArray<{
  readonly verb: RegExp;
  readonly tools: readonly string[];
}> = [
  { verb: /\b(sent|emailed|e-mailed)\b/i, tools: ["send_email"] },
  { verb: /\b(posted|published|shared)\b/i, tools: ["linkedin_post", "schedule_social_post"] },
  { verb: /\b(scheduled|queued)\b/i, tools: ["schedule_task", "schedule_social_post"] },
  { verb: /\b(booked|invited)\b/i, tools: ["create_calendar_event"] },
  { verb: /\b(deployed|shipped|released)\b/i, tools: ["deploy_static_site", "project_workflow"] },
  { verb: /\b(committed|pushed|merged|opened a pr)\b/i, tools: ["github_write"] },
  { verb: /\b(wrote|saved|created the file)\b/i, tools: ["write_file", "write_artifact"] },
  { verb: /\b(ran|executed)\b/i, tools: ["run_shell", "vps_run", "project_workflow"] },
];

/**
 * Markers that make a sentence a proposal, question or intention rather than a
 * claim of completion. Checked before the verb so "I will send it" is not a claim.
 */
const NON_ASSERTION =
  /\b(will|shall|would|could|can|should|going to|about to|let me|i'll|i will|plan to|ready to|once you|if you|after you|want me to|need me to)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tool families the reply claims to have already used.
 * Returns a de-duplicated list; empty means the reply asserted no external action.
 */
export function detectActionClaims(reply: string): string[] {
  const claimed = new Set<string>();
  for (const sentence of sentences(reply)) {
    if (sentence.endsWith("?")) continue;
    if (NON_ASSERTION.test(sentence)) continue;
    for (const { verb, tools } of ACTION_CLAIM_LEXICON) {
      if (verb.test(sentence)) for (const t of tools) claimed.add(t);
    }
  }
  return [...claimed];
}

// ── Fabrication ──────────────────────────────────────────────────────────────

/**
 * Claimed tool families with no successful receipt to back them.
 *
 * A claim counts as backed if ANY successful receipt names a tool in its family —
 * the lexicon maps one verb to several plausible tools, so a single match suffices.
 */
export function fabricatedClaims(
  reply: string,
  receipts: readonly ToolReceipt[],
): string[] {
  const succeeded = new Set(receipts.filter((r) => r.ok).map((r) => r.tool));
  const fabricated: string[] = [];

  for (const sentence of sentences(reply)) {
    if (sentence.endsWith("?")) continue;
    if (NON_ASSERTION.test(sentence)) continue;
    for (const { verb, tools } of ACTION_CLAIM_LEXICON) {
      if (!verb.test(sentence)) continue;
      if (tools.some((t) => succeeded.has(t))) continue;
      for (const t of tools) if (!fabricated.includes(t)) fabricated.push(t);
    }
  }
  return fabricated;
}

/**
 * Share of runs containing at least one fabricated claim.
 *
 * Counts RUNS, not claims, so a verbose reply making five unbacked claims cannot
 * skew the rate more than a terse one making a single unbacked claim.
 */
export function fabricationRate(runs: readonly ArmRun[]): number {
  if (runs.length === 0) return 0;
  const bad = runs.filter((r) => fabricatedClaims(r.reply, r.receipts).length > 0).length;
  return bad / runs.length;
}

// ── Determinism ──────────────────────────────────────────────────────────────

/**
 * Share of repeated runs that produced the modal (most common) plan.
 *
 * Returns 0 when no two runs agree — determinism requires at least one
 * reproduction, so an all-distinct result is total non-determinism, not 1/n.
 * A single run is trivially deterministic.
 */
export function planDeterminism(planHashes: readonly string[]): number {
  if (planHashes.length <= 1) return 1;

  const counts = new Map<string, number>();
  for (const h of planHashes) counts.set(h, (counts.get(h) ?? 0) + 1);

  const modal = Math.max(...counts.values());
  if (modal === 1) return 0;
  return modal / planHashes.length;
}

// ── Idempotency ──────────────────────────────────────────────────────────────

/**
 * Number of duplicate successful sends: extra successful receipts sharing an
 * idempotency key. Failed receipts are ignored — a failed send is not a send.
 */
export function doubleSendCount(receipts: readonly ToolReceipt[]): number {
  const perKey = new Map<string, number>();
  for (const r of receipts) {
    if (!r.ok || !r.idempotency_key) continue;
    perKey.set(r.idempotency_key, (perKey.get(r.idempotency_key) ?? 0) + 1);
  }
  let extra = 0;
  for (const n of perKey.values()) if (n > 1) extra += n - 1;
  return extra;
}

// ── Failure clarity ──────────────────────────────────────────────────────────

/**
 * How debuggable a failure is, scored 0–1 over three components:
 * a typed stage, a named component, and attached evidence.
 * An opaque or untyped error scores 0.
 */
export function failureClarity(failure: FailureReport | null | undefined): number {
  if (!failure) return 0;
  const parts = [
    Boolean(failure.stage),
    Boolean(failure.component),
    Boolean(failure.evidence),
  ];
  return parts.filter(Boolean).length / parts.length;
}

// ── Aggregates ───────────────────────────────────────────────────────────────

export interface ArmSummary {
  readonly arm: ArmId;
  readonly runs: number;
  readonly fabrication_rate: number;
  readonly total_usd: number;
  readonly mean_ms: number;
  readonly double_sends: number;
}

export function summariseArm(arm: ArmId, runs: readonly ArmRun[]): ArmSummary {
  const receipts = runs.flatMap((r) => [...r.receipts]);
  return {
    arm,
    runs: runs.length,
    fabrication_rate: fabricationRate(runs),
    total_usd: runs.reduce((sum, r) => sum + r.usd, 0),
    mean_ms: runs.length === 0 ? 0 : runs.reduce((sum, r) => sum + r.ms, 0) / runs.length,
    double_sends: doubleSendCount(receipts),
  };
}
