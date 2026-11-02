/**
 * Progress chatter the gateway streams while a turn runs (src/gateway/kernel-progress.ts). It is NOT the answer, and
 * counting it as the answer is a false green: the first run of telegram-probe.ts reported "OK, 1 reply in 9s" for a
 * turn that took 200s because "🤔 Working on it…" arrived first. On 10-07 "On it: …" passed as the answer at 3s; the
 * reply came at 7s (PR #1002). Shared by scripts/telegram-probe.ts and scripts/journey-daily.ts.
 */

const TRANSIENT_PREFIXES = ["🤔", "🔧", "✍️", "🔍", "📋", "⏳", "📝", "🧠"];
/** Step labels from src/gateway/kernel-progress.ts. */
const PROGRESS_LABELS = [/^On it: /, /^Step \d+ of \d+: /, /^All \d+ steps? done$/];

export function isProgressChatter(text: string): boolean {
  const t = text.trimStart();
  return t.length === 0 || TRANSIENT_PREFIXES.some((p) => t.startsWith(p)) || PROGRESS_LABELS.some((re) => re.test(t));
}
