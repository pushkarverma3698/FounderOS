/**
 * Cookie banner: decline it so it neither blocks Submit nor hides the bot check
 * ==============================================================================
 * Root cause of the 2026-11-16 Nebius auto-send timeout (#1322): careers.nebius.com shows a OneTrust banner whose
 * `.onetrust-pc-dark-filter` overlay "intercepts pointer events", so Playwright's Submit click retried until its 10s
 * timeout. The same page loads its Cloudflare Turnstile script only after the consent choice, so the detector saw a
 * clean form and the row routed to `auto`. Declining non-essential cookies (the privacy-preserving choice) clears both.
 */

import type { Page } from "playwright";

/** Reject-all controls, most specific first. Never an "accept" control. */
const REJECT_SELECTORS = [
  "#onetrust-reject-all-handler",
  "button#truste-consent-required",
  ".cky-btn-reject",
  "#CybotCookiebotDialogBodyButtonDecline",
  'button[aria-label*="reject all" i]',
];
const VISIBLE_REJECT = REJECT_SELECTORS.map((sel) => `${sel}:visible`).join(", ");

const SETTLE_MS = 1_200;

/** Decline the cookie banner when one is showing. True when a control was clicked. Never throws. */
export async function dismissCookieBanner(page: Page): Promise<boolean> {
  const button = page.locator(VISIBLE_REJECT).first();
  // allow-failopen: a failed count means no banner is known.
  if ((await button.count().catch(() => 0)) === 0) return false;
  // allow-failopen: no banner, a banner we do not know, or a click that fails leaves the page as it was.
  const clicked = await button.click({ timeout: 1_500 }).then(() => true, () => false);
  if (clicked) await page.waitForTimeout(SETTLE_MS).catch(() => undefined); // allow-failopen: a closed page just skips the wait.
  return clicked;
}
