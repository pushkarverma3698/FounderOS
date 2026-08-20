/**
 * FounderOS — asynchronous answer-quality evaluation sink.
 * =========================================================
 * FounderOS already has GUARDS — `flagDangerousCommand`, `hitlGate`, budget caps.
 * A guard blocks one specific failure inline, on a millisecond budget. This is the
 * other half: an EVALUATOR, which scores the quality of a reply the founder has
 * already received, asynchronously, and records the verdict.
 *
 * Two invariants make it an evaluator rather than a guard:
 *
 *  1. **It never touches the reply.** `recordAnswerEvaluation` returns void
 *     immediately; the judge call happens after the founder already has the answer.
 *     A `revise`-grade score is a stored row, not a block. HITL stays the only gate.
 *
 *  2. **"Not evaluated" never looks like "passed".** The scores are NULL and the
 *     status is `not_evaluated` with a reason string, so a judge outage cannot be
 *     read as a clean bill of health — the invariant `rag-optimization-sweep.ts`
 *     exists to hold, applied to answers instead of vectors.
 */

import { getDb } from "../db/client.js";
import { answerEvaluations, type NewAnswerEvaluation } from "../db/schema.js";
import { judgeAnswer, judgeModelLabel, type AnswerJudgeStep, type AnswerJudgement } from "./judge.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "answer-eval" });

/** Goal chars stored per row — enough to read the row without a join, not a transcript. */
export const EVAL_GOAL_MAX_CHARS = 500;
/** Reply chars stored per row, for the same reason. */
export const EVAL_REPLY_MAX_CHARS = 2_000;
/** Default tenant, matching every other operational table. */
export const EVAL_DEFAULT_TENANT = "turicks";
/** Groundedness at or below this is the row a human should read first — see `answer_evaluations` doc. */
export const GROUNDEDNESS_ATTENTION_THRESHOLD = 70;

/** One completed turn, narrowed at the boundary to what an evaluation needs. */
export interface CompletedTurn {
  readonly turnId: string;
  readonly threadId: string;
  readonly goal: string;
  readonly reply: string;
  readonly steps: readonly AnswerJudgeStep[];
  readonly tenantId?: string;
}

/** Injected for tests so no unit test ever needs a judge model or a database. */
export interface AnswerEvalDeps {
  readonly judge?: (turn: CompletedTurn) => Promise<AnswerJudgement>;
  readonly write?: (row: NewAnswerEvaluation) => Promise<void>;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * PURE: turn + judgement → the row to store. Scores are present only when the
 * judgement is `evaluated`; otherwise they are null and `not_evaluated_reason`
 * carries the sentence explaining why, so the two states can never be confused.
 */
export function buildAnswerEvalRow(
  turn: CompletedTurn,
  judgement: AnswerJudgement,
  judgeModel: string,
): NewAnswerEvaluation {
  const base = {
    tenant_id: turn.tenantId ?? EVAL_DEFAULT_TENANT,
    turn_id: turn.turnId,
    thread_id: turn.threadId,
    goal: truncate(turn.goal, EVAL_GOAL_MAX_CHARS),
    reply: truncate(turn.reply, EVAL_REPLY_MAX_CHARS),
    planned_steps: turn.steps.length,
    judge_model: judgeModel,
  };
  if (judgement.status === "not_evaluated") {
    return {
      ...base,
      status: "not_evaluated",
      not_evaluated_reason: judgement.reason,
      groundedness: null,
      relevance: null,
      completeness: null,
      critique: null,
    };
  }
  const { groundedness, relevance, completeness, critique } = judgement.scores;
  return {
    ...base,
    status: "evaluated",
    not_evaluated_reason: null,
    groundedness,
    relevance,
    completeness,
    critique: critique || null,
  };
}

/**
 * Run the evaluation and persist exactly one row — including when the judge could
 * not be reached, because an unscored turn that leaves no row is indistinguishable
 * from a turn nobody ever tried to score.
 *
 * Awaited only by tests and by the fire-and-forget wrapper below.
 */
export async function evaluateCompletedTurn(
  turn: CompletedTurn,
  deps: AnswerEvalDeps = {},
): Promise<AnswerJudgement> {
  const judge = deps.judge ?? ((t: CompletedTurn) => judgeAnswer({ goal: t.goal, reply: t.reply, steps: t.steps }));
  const write =
    deps.write ??
    (async (row: NewAnswerEvaluation) => {
      await getDb().insert(answerEvaluations).values(row);
    });

  const judgement = await judge(turn);
  await write(buildAnswerEvalRow(turn, judgement, judgeModelLabel()));

  if (judgement.status === "evaluated" && judgement.scores.groundedness <= GROUNDEDNESS_ATTENTION_THRESHOLD) {
    log.warn(
      {
        turnId: turn.turnId,
        groundedness: judgement.scores.groundedness,
        relevance: judgement.scores.relevance,
        completeness: judgement.scores.completeness,
        critique: judgement.scores.critique,
      },
      `Turn ${turn.turnId} scored ${judgement.scores.groundedness}/100 on groundedness — a claim in the reply may have no step result behind it`,
    );
  }
  return judgement;
}

/**
 * FIRE-AND-FORGET entry point — the ONLY one the reply path may call.
 *
 * Returns synchronously. The judge call, the DB write and any failure in either
 * happen after the caller has moved on, so the founder's reply latency is
 * unchanged whether the judge is fast, slow, or entirely down.
 */
export function recordAnswerEvaluation(turn: CompletedTurn, deps: AnswerEvalDeps = {}): void {
  // allow-failopen: an evaluator must never affect the turn it is grading — a failed
  // evaluation is logged and dropped, and the missing row is itself the signal.
  void evaluateCompletedTurn(turn, deps).catch((err: unknown) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), turnId: turn.turnId },
      `Answer evaluation failed for turn ${turn.turnId} — this turn has no quality row`,
    );
  });
}
