/**
 * FounderOS — the repository picker (PURE)
 * ========================================
 * Turns "which repo?" from a syntax you have to remember into a row of buttons
 * you tap.
 *
 * WHY THIS EXISTS. `/task repo:app fix the login` has three things to remember:
 * the command, that `repo:` exists at all, and which short word maps to which
 * repository. Miss the middle one and the old parser did not complain — it fell
 * through to FounderOS and filed employer work in the wrong repository with the
 * stray word still in the brief. A prefix nobody can forget is better than a
 * prefix with a good error message, and a button cannot be misspelt.
 *
 * ## No server-side state, deliberately
 *
 * Two flows need to remember something between messages, and neither of them
 * stores it here:
 *
 *   · "which repo for the text he already sent" — the picker is sent AS A REPLY
 *     to his `/task …` message, so `reply_to_message.text` gives the text back
 *     when the button is tapped.
 *   · "what should I build in the repo he just picked" — the prompt carries a
 *     visible `Repo: owner/name` line and asks for a reply, so the answer
 *     arrives already attached to the message naming the target.
 *
 * The conversation is the state. A restart mid-flow loses nothing, and there is
 * no map keyed by chat id to leak, expire, or get wrong.
 *
 * ## Callback data is never trusted
 *
 * `repoFromCallbackData` re-resolves through `matchAllowlistedRepos` rather than
 * taking the slug at face value. The allowlist is the only thing standing
 * between a malformed dispatch and every repository the VPS token can write to
 * (see src/tools/dispatch-repos.ts), and a value that made a round trip through
 * a Telegram client is external input like any other.
 */

import { DISPATCH_REPO_ALLOWLIST, matchAllowlistedRepos } from "../tools/dispatch-repos.js";

/** Telegram rejects `callback_data` over 64 bytes — the whole keyboard, not just the button. */
export const MAX_CALLBACK_BYTES = 64;

export const REPO_CALLBACK_PREFIX = "task:repo:";

/** The line the reply-prompt carries so the founder's answer knows its own target. */
export const REPO_PROMPT_LABEL = "Repo:";

export interface RepoChoice {
  readonly slug: string;
  /** What the button says. Short: Telegram truncates a long label on a phone. */
  readonly label: string;
}

/**
 * Human names for the hardcoded repos.
 *
 * `oplify-messaging-app` and `oplify-messaging-api` differ by one character in
 * the middle of a long string, which is exactly the shape a person mis-taps.
 * The emoji and the app/api split carry the difference instead.
 */
const REPO_LABELS: Readonly<Record<string, string>> = {
  "pushkarverma3698/FounderOS": "🏠 FounderOS",
  "OplifyMessage/oplify-messaging-app": "📱 Oplify app",
  "OplifyMessage/oplify-messaging-api": "🔌 Oplify API",
  "pushkarverma3698/House-of-Hulda-Website-frontend": "🌸 Hulda site",
};

/** `owner/name` → `name`. The half that identifies the repo to a human. */
function repoName(slug: string): string {
  return slug.split("/")[1] ?? slug;
}

export function labelForRepo(slug: string): string {
  return REPO_LABELS[slug] ?? `📦 ${repoName(slug)}`;
}

/**
 * The callback payload for one repo, or null when it would not fit.
 *
 * Only the name half travels: it is what `matchAllowlistedRepos` matches on, and
 * halving the length keeps repos created from Telegram inside the budget. A repo
 * whose name alone busts 64 bytes gets no button rather than a keyboard Telegram
 * refuses whole — one missing button is recoverable by typing, a rejected
 * `sendMessage` is not.
 */
export function repoCallbackData(slug: string): string | null {
  const data = `${REPO_CALLBACK_PREFIX}${repoName(slug)}`;
  return Buffer.byteLength(data, "utf8") <= MAX_CALLBACK_BYTES ? data : null;
}

/** Every repo the founder may dispatch to, hardcoded first, then ones he created. */
export function repoChoices(registered: readonly string[] = []): readonly RepoChoice[] {
  const extra = registered.filter((slug) => !DISPATCH_REPO_ALLOWLIST.includes(slug as never));
  return [...DISPATCH_REPO_ALLOWLIST, ...new Set(extra)]
    .filter((slug) => repoCallbackData(slug) !== null)
    .map((slug) => ({ slug, label: labelForRepo(slug) }));
}

/**
 * The repo a tapped button means, re-resolved against the allowlist.
 *
 * Returns null for anything that does not resolve to exactly one repository —
 * an unknown name, an ambiguous one, or a payload that is not ours. The caller
 * says so out loud; guessing here would put a PR in a repo nobody named.
 */
export function repoFromCallbackData(data: string, registered: readonly string[] = []): string | null {
  if (!data.startsWith(REPO_CALLBACK_PREFIX)) return null;
  const matches = matchAllowlistedRepos(data.slice(REPO_CALLBACK_PREFIX.length), registered);
  return matches.length === 1 ? (matches[0] as string) : null;
}

/** Two buttons per row: full-width labels wrap and read badly on a phone. */
export function buildRepoKeyboardRows(
  registered: readonly string[] = [],
): { text: string; callback_data: string }[][] {
  const buttons = repoChoices(registered).flatMap((choice) => {
    const data = repoCallbackData(choice.slug);
    return data ? [{ text: choice.label, callback_data: data }] : [];
  });

  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

/**
 * The question asked when he typed `/task <work>` without naming a repository.
 *
 * Echoes the work back. The founder tapping this button is committing real
 * unattended engineering time to it, and a bare "Which repo?" asks him to
 * approve a dispatch whose content is off-screen.
 */
export function buildRepoQuestion(text: string): string {
  const shown = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return `🤖 <b>Which repo?</b>\n\n<i>${escapeHtml(shown)}</i>`;
}

/**
 * The prompt shown when he tapped `/task` with nothing to build yet.
 *
 * The `Repo:` line is load-bearing as well as informative: his reply to this
 * message is how the chosen repository gets back to the handler, so the target
 * is on screen at the moment he describes the work.
 */
export function buildRepoPrompt(slug: string): string {
  return (
    `${labelForRepo(slug)} — <b>what should I build?</b>\n\n` +
    `<i>Reply to this message with it in plain English. One line is enough.</i>\n\n` +
    `${REPO_PROMPT_LABEL} <code>${escapeHtml(slug)}</code>`
  );
}

/**
 * Reads the repository back out of a prompt the founder replied to.
 *
 * Matches the LAST `Repo:` line so quoted text earlier in the message cannot
 * retarget it — the same reasoning that makes `repo:` honoured only as the first
 * token of `/task`. Re-resolved against the allowlist for the same reason
 * `repoFromCallbackData` is.
 */
export function repoFromPrompt(text: string, registered: readonly string[] = []): string | null {
  // Tags are stripped first so one function serves both callers. Telegram
  // delivers `reply_to_message.text` with the formatting removed, so what
  // arrives at runtime is `Repo: owner/name`; what buildRepoPrompt returns is
  // the same line wrapped in <code>. Matching only one of those shapes gives a
  // function that passes its test and fails in the chat, or the reverse.
  const plain = text.replace(/<[^>]*>/g, "");
  const matches = [...plain.matchAll(new RegExp(`${REPO_PROMPT_LABEL}\\s*([\\w.-]+/[\\w.-]+)`, "g"))];
  const last = matches.at(-1)?.[1];
  if (!last) return null;
  const resolved = matchAllowlistedRepos(last, registered);
  return resolved.length === 1 ? (resolved[0] as string) : null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
