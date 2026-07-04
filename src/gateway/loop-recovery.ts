/**
 * FounderOS — Loop Recovery (launch-critical, 2026-07-03)
 * ======================================================
 * Live prod finding (T35, 4-part chained knowledge question): the supervisor can
 * re-transfer between departments until OFFICE_RECURSION_LIMIT → GraphRecursionError.
 * Before this module, the gateway just cleared the thread and told the founder to
 * "send your next message" — the task was NEVER completed.
 *
 * The founder's launch requirement is stronger: a Claude-Code-style operator must
 * "get over the hallucination" and ULTIMATELY do the task — or, only if it truly
 * cannot, stop and say so honestly. This module is that recover-or-stop step:
 *
 *   loop detected (recursion abort) → clear thread → ONE bounded recovery pass with
 *   a forced SINGLE-PASS synthesis directive + a small recursion cap → if it yields
 *   a real answer, deliver it (task done); else emit an honest "break it down" notice.
 *
 * The decision logic is deterministic and unit-tested (rule #16 / #19.3) — the
 * loop-break is a pure function over a fake invoke, never a prompt instruction the
 * weak model may ignore. The one prompt lever (the directive) is bounded by the
 * recursion cap so a non-compliant model can only loop cheaply, then we stop loud.
 */

/**
 * Recursion budget for the recovery pass. Deliberately small: if the model loops
 * AGAIN despite the single-pass directive, it must abort cheaply (a few calls),
 * not grind to the full OFFICE_RECURSION_LIMIT a second time.
 */
export const RECOVERY_RECURSION_LIMIT = 8;

/**
 * The forced single-pass directive. Targets the measured root cause: repeated
 * department transfers on a multi-part question. Told to answer every part in one
 * pass and never re-transfer more than once.
 */
export const LOOP_RECOVERY_DIRECTIVE =
  "[LOOP RECOVERY — SINGLE PASS REQUIRED]\n" +
  "You just got stuck re-transferring between departments on this request and were stopped.\n" +
  "Answer it NOW in ONE pass:\n" +
  "- Do NOT transfer to any department more than once.\n" +
  "- For a multi-part question, answer EVERY part directly from what you already know or a single tool call.\n" +
  "- If you already gathered partial information, synthesize it into the complete answer.\n" +
  "Produce the founder's complete answer as plain text now — do not narrate routing or tools.";

/** Honest stop shown only when the recovery pass ALSO fails to complete. */
export const LOOP_RECOVERY_FAILED_MESSAGE =
  "🔁 <b>I got stuck in a loop on that one</b> and couldn't complete it even after retrying, " +
  "so I stopped to avoid runaway cost.\n" +
  "Please break it into smaller, single-step asks (one question at a time) — I'll handle each cleanly.";

/** Compose the recovery-pass input: directive prefix + the founder's original ask. */
export function buildRecoveryInput(userText: string): string {
  return `${LOOP_RECOVERY_DIRECTIVE}\n\nThe founder's original request was:\n${userText}`;
}

/** Reply language that means the recovery pass itself failed/looped — never deliver these. */
const RECOVERY_NON_ANSWER_RE =
  /got stuck|stuck in a loop|runaway cost|recursion limit|took too long/i;

/**
 * True when a recovery-pass reply is a real, deliverable answer (not empty, not
 * another stuck/loop notice). Pure — unit-tested.
 */
export function isUsableRecoveryReply(reply: string): boolean {
  const text = reply.trim();
  if (text.length < 8) return false;
  if (RECOVERY_NON_ANSWER_RE.test(text)) return false;
  return true;
}

export interface RecoveryOutcome {
  status: "recovered" | "failed";
  /** Present only when status === "recovered". */
  reply?: string;
}

/**
 * Run one bounded recovery pass via the injected `runRecovery` (which performs the
 * real office invoke and returns the final reply text). Classifies the result into
 * recovered-with-answer vs failed. Never throws — a recovery pass that itself loops
 * or times out resolves to `failed`, so the caller can emit the honest stop notice.
 */
export async function attemptLoopRecovery(
  runRecovery: () => Promise<string>,
): Promise<RecoveryOutcome> {
  try {
    const reply = await runRecovery();
    if (isUsableRecoveryReply(reply)) return { status: "recovered", reply };
    return { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}
