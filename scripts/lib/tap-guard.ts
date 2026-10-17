/**
 * What the live tester may tap (scripts/telegram-tap.ts).
 *
 * The tester is the founder's own Telegram account, so a tap is the founder's tap. Submit sends a real job
 * application to a real employer, and only the founder presses it. The guard refuses the auto-apply Submit
 * callback (`jh:s:`, src/gateway/auto-apply.ts) and any button labelled Submit, so a renamed callback cannot
 * slip through.
 *
 * Exception: when the founder authorises real applications in chat, the run names those rows in
 * `TAP_ALLOW_SUBMIT_ROWS=<rowId>,<rowId>`. Only `jh:s:<rowId>` for an exact listed id is then pressed.
 */

export interface TapButton {
  readonly label: string;
  /** callback_data of an inline callback button. */
  readonly data?: string;
  /** Target of an inline URL or web_app button; never tappable, printed so the tester can open it. */
  readonly url?: string;
  /** A web_app button: Telegram opens `url` inside the app as a Mini App. */
  readonly webApp?: boolean;
}

const SUBMIT_CALLBACK_PREFIXES = ["jh:s:"] as const;

/** Row ids from `TAP_ALLOW_SUBMIT_ROWS` (comma-separated). */
export function allowedSubmitRows(raw: string | undefined): readonly string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Why this button must not be tapped, or null when it may be. */
export function tapRefusal(button: TapButton, allowSubmitRows: readonly string[] = []): string | null {
  const data = button.data ?? "";
  const prefix = SUBMIT_CALLBACK_PREFIXES.find((p) => data.startsWith(p));
  if (prefix && allowSubmitRows.includes(data.slice(prefix.length))) return null;
  if (prefix || /submit/i.test(button.label)) {
    return `refused: "${button.label}" is a Submit button. Only the founder presses Submit, or names the row in TAP_ALLOW_SUBMIT_ROWS.`;
  }
  return null;
}

/** The callback button carrying exactly this data on the message, if there is one. */
export function findButton(buttons: readonly TapButton[], data: string): TapButton | undefined {
  return buttons.find((b) => b.data === data);
}
