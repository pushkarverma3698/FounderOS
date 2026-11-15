/**
 * FounderOS — read back a typed value, tolerating phone widgets
 * =============================================================
 * Workable's phone box is intl-tel-input: typing "+31 6 12345678" moves the dial code into the country flag and
 * leaves "6 12345678" in the input. A strict equality read-back called that correct fill unverified, so /apply asked
 * for the phone again (JoVE, 2026-11-14). For `type=tel` inputs the shown digits only have to be the tail of the
 * typed number (national format, trunk 0 dropped); every other input still needs an exact match.
 */

import type { Locator } from "playwright";

/** Fewer digits than this cannot identify a number, so a short tail never counts as a match. */
export const MIN_PHONE_TAIL_DIGITS = 6;

/** Digits only, with an international "00" prefix removed. */
const digitsOf = (s: string): string => s.replace(/\D/g, "").replace(/^00/, "");

/** True when `shown` is the typed number as a phone widget displays it (national part, or the whole number). */
export function phoneShownMatches(typed: string, shown: string): boolean {
  const want = digitsOf(typed);
  const got = digitsOf(shown).replace(/^0+/, "");
  if (got.length < MIN_PHONE_TAIL_DIGITS || want.length < MIN_PHONE_TAIL_DIGITS) return false;
  return want.endsWith(got) || got.endsWith(want);
}

/** Does the input now hold what was typed? Exact for text; widget-reformatted digits are accepted for `type=tel`. */
export async function fieldHoldsValue(locator: Locator, value: string): Promise<boolean> {
  // allow-failopen: an unreadable value reports false so the caller records the field as unverified.
  const shown = await locator.inputValue().catch(() => "");
  if (shown === value) return true;
  // allow-failopen: an unreadable type is treated as a plain text input.
  const type = await locator.getAttribute("type").catch(() => null);
  return type?.toLowerCase() === "tel" && phoneShownMatches(value, shown);
}
