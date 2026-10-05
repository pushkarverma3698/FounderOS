/**
 * FounderOS — empty states with one example (P2-3, audit F24).
 * ===========================================================
 * "no focus set - send /focus <text>" tells the founder the syntax and nothing else:
 * a dead end on first use. Each empty state now carries one example in a <code> span,
 * which Telegram copies on tap; he edits the text and sends.
 *
 * The text is static, so it is safe to send as HTML. Replies that echo the founder's
 * own words (focus-commands.ts) stay plain text.
 */

export type EmptyStateKind = "focus" | "projects" | "remind";

/** One example per command, written so that sending it unedited is a valid use. No <, > or &. */
export const EMPTY_STATE_EXAMPLES: Readonly<Record<EmptyStateKind, string>> = {
  focus: "/focus Close the Acme pilot",
  projects: "/projects FounderOS; Naggar site",
  remind: "/remind call the landlord at 3pm",
};

const LEAD: Readonly<Record<EmptyStateKind, string>> = {
  focus: "No focus set yet.",
  projects: "No projects set yet. Put a semicolon between projects.",
  remind: "A reminder needs what and when.",
};

/** Telegram HTML for the empty state of `kind`: what is missing, then the tappable example. */
export function emptyStateHtml(kind: EmptyStateKind): string {
  return `${LEAD[kind]}\nTap the line below to copy it, change the text, and send it:\n<code>${EMPTY_STATE_EXAMPLES[kind]}</code>`;
}
