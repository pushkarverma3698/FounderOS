/**
 * What the live tester may tap (scripts/telegram-tap.ts).
 *
 * The tester is the founder's own Telegram account, so a tap is the founder's tap. Submit sends a real job
 * application to a real employer, and only the founder presses it. The guard refuses the auto-apply Submit
 * callback (`jh:s:`, src/gateway/auto-apply.ts) and any button labelled Submit, so a renamed callback cannot
 * slip through.
 */

export interface TapButton {
  readonly label: string;
  /** callback_data of an inline callback button. */
  readonly data?: string;
  /** Target of an inline URL button; never tappable, printed so the tester can open it. */
  readonly url?: string;
}

const SUBMIT_CALLBACK_PREFIXES = ["jh:s:"] as const;

/** Why this button must not be tapped, or null when it may be. */
export function tapRefusal(button: TapButton): string | null {
  const data = button.data ?? "";
  if (SUBMIT_CALLBACK_PREFIXES.some((p) => data.startsWith(p)) || /submit/i.test(button.label)) {
    return `refused: "${button.label}" is a Submit button. Only the founder presses Submit.`;
  }
  return null;
}

/** The callback button carrying exactly this data on the message, if there is one. */
export function findButton(buttons: readonly TapButton[], data: string): TapButton | undefined {
  return buttons.find((b) => b.data === data);
}
