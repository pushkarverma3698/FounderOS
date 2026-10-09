/**
 * The founder's own words for a coding job (AG-062).
 * ==================================================
 * Prod, 2026-10-09: the dispatch tools took his words from a model-written `founder_request` argument, and the worker
 * wrote planner text there ("Pick the first open issue found in s1…"). The words now come from the gateway, which
 * puts his message in `configurable.founder_text`. The run that resumes after his Approve tap has no founder_text
 * (kernel-run.ts), so the words are read back from the card he approved, which carries them in `args.founder_words`.
 *
 * They reach the coding run on the issue itself, as one hidden comment line; deploy/lib/job-prompt.sh reads the newest.
 */

const DISPATCH_ACTIONS: ReadonlySet<unknown> = new Set(["dispatch_antigravity_task", "requeue_antigravity_task"]);

/** His message for this turn, else the words on the dispatch card he just approved, else "". */
export function founderWordsFrom(configurable: Record<string, unknown> | undefined): string {
  const live = configurable?.["founder_text"];
  if (typeof live === "string" && live.trim()) return live;
  const resumed = configurable?.["hitl_resumed"];
  if (typeof resumed !== "string") return "";
  let card: { action?: unknown; args?: { founder_words?: unknown } };
  try {
    card = JSON.parse(resumed);
  } catch {
    // allow-failopen: a card that cannot be read carries no words; the caller then refuses or files without them
    return "";
  }
  const words = card?.args?.founder_words;
  return DISPATCH_ACTIONS.has(card?.action) && typeof words === "string" ? words : "";
}

/** The hidden line a queue comment carries. Base64, so any text (newlines, "-->") round-trips exactly. */
export function founderWordsMarker(words: string): string {
  return `<!-- founder-words: ${Buffer.from(words, "utf8").toString("base64")} -->`;
}
