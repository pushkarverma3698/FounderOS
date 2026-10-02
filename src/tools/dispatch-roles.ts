/**
 * FounderOS — who does what in the agent loop, in the words the founder reads
 * ==========================================================================
 * One place for the reviewer's name. The text used to say "Claude reviews" in seven files (the approval
 * card's acceptance criteria, /tasks, /start, /commands, /task's usage, the status tool, the daemon's
 * notifications) while the reviewer was, for a week, not Claude: pr-brain's engine is configurable
 * (PR_BRAIN_ENGINE in deploy/vps-daemons/pr-brain; agy is the default, claude the alternative), and
 * Claude's usage limit had paused every review. A founder who is told "Claude is gating it" while
 * Claude is down is being told something false, so the text names the ROLE, which does not change.
 *
 * The role is what matters to him: a reviewer that is not the executor. pr-brain gives it a different
 * model in a fresh conversation, so "the executor is never its own grader" holds on either engine.
 */

/** The daemon that reviews every agent PR (deploy/vps-daemons/pr-brain). */
export const REVIEWER = "pr-brain";

/** As a noun phrase, for a sentence: "… and ${REVIEWER_PHRASE} reviews the PR". */
export const REVIEWER_PHRASE = "an independent reviewer (pr-brain)";

/** The default acceptance criteria every dispatched brief carries when the caller gives none. */
export const DEFAULT_ACCEPTANCE_TEXT =
  "All verification commands pass; the independent reviewer (pr-brain) clears the review with no BLOCKER.";
