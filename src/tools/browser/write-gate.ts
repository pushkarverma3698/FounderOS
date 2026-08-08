/**
 * FounderOS — Browser Write Gate
 * ==============================
 * Decides which browser actions need founder approval.
 *
 * This is PURE CODE and unit-tested, never a prompt instruction — per the kernel
 * rule that routing and guards are deterministic functions. A model cannot talk
 * its way past it, and a regression shows up as a failing table row rather than
 * as a silently-submitted form.
 *
 * Policy: reads run free, writes stop. Gating every action produced twenty
 * approval cards for a twenty-step task, which is why the previous browser tool
 * went unused.
 */

import type { BrowserRequest, Ref } from "./types.js";

/**
 * Irreversible side effects. Gated on ANY role, including links — the cost of a
 * false negative here is money moved or data destroyed, so a little noise on
 * links is the right trade.
 */
const HIGH_SEVERITY_VERBS = [
  "delete",
  "remove",
  "buy",
  "purchase",
  "order",
  "pay",
  "checkout",
  "transfer",
  "withdraw",
  "deposit",
  "cancel",
];

/**
 * Reversible-ish side effects. Gated on buttons and form controls, but NOT on
 * links, because a link click navigates and you can go back.
 *
 * This role distinction exists because whole-word matching alone is not enough:
 * "Post office finder" contains `post` as a genuine whole word and would
 * otherwise raise an approval card for a navigation link. There is no robust way
 * to tell a verb from a noun modifier in an accessible name, so the role carries
 * the signal instead.
 *
 * Residual risk, stated plainly: a site that renders a destructive control as a
 * bare <a> with a low-severity name gets through. Anything genuinely destructive
 * is covered by HIGH_SEVERITY_VERBS or by `submits`.
 */
const LOW_SEVERITY_VERBS = [
  "submit",
  "send",
  "post",
  "publish",
  "confirm",
  "save",
  "apply",
  "accept",
  "agree",
  "subscribe",
];

const NAVIGATIONAL_ROLES = new Set(["link", "menuitem", "tab"]);

/**
 * Fields we refuse to fill under any circumstances. These are NOT turned into
 * approval cards — the founder is asked to do it themselves.
 */
const NEVER_FILL = [
  "password",
  "passcode",
  "card number",
  "cardnumber",
  "credit card",
  "cvv",
  "cvc",
  "security code",
  "social security",
  "ssn",
  "passport",
  "national insurance",
  "routing number",
  "account number",
  "pin",
];

const CAPTCHA_HINTS = ["not a robot", "captcha", "recaptcha", "hcaptcha", "verify you are human"];

/** URL parameters that indicate an auth or payment handshake. */
const SENSITIVE_URL_PARAMS = ["code", "token", "access_token", "id_token", "state", "oauth", "payment_intent"];

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

function hasWholeWord(text: string, needle: string): boolean {
  return words(text).includes(needle);
}

function containsPhrase(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase);
}

/**
 * Actions that must never be automated, gate or no gate. Returning true here
 * means the tool refuses and tells the founder to act, rather than raising an
 * approval card.
 */
export function isNeverAutomated(req: BrowserRequest, element: Ref | undefined): boolean {
  if (!element) return false;

  if (req.action === "type") {
    if (element.secure) return true;
    if (NEVER_FILL.some((phrase) => containsPhrase(element.name, phrase))) return true;
  }

  if (req.action === "click" && CAPTCHA_HINTS.some((hint) => containsPhrase(element.name, hint))) {
    return true;
  }

  return false;
}

/**
 * Whether this action needs founder approval before it runs.
 *
 * Fails CLOSED: if we could not resolve the target element, we cannot reason
 * about what it does, so it is gated. Guessing in the permissive direction is
 * the silent failure; guessing in the restrictive direction is merely annoying.
 */
export function isWriteAction(req: BrowserRequest, element: Ref | undefined): boolean {
  switch (req.action) {
    // Pure reads and camera movements — never gated.
    case "snapshot":
    case "scroll":
    case "back":
    case "screenshot":
    case "wait_for":
      return false;

    case "navigate": {
      if (!req.url) return false;
      return hasSensitiveParams(req.url);
    }

    case "type": {
      if (!element) return true;
      return Boolean(element.secure);
    }

    case "select":
      return false;

    case "click": {
      if (!element) return true;
      if (element.submits) return true;

      const name = element.name;
      if (HIGH_SEVERITY_VERBS.some((verb) => hasWholeWord(name, verb))) return true;

      // Links navigate; buttons act. See LOW_SEVERITY_VERBS for why.
      if (NAVIGATIONAL_ROLES.has(element.role.toLowerCase())) return false;
      return LOW_SEVERITY_VERBS.some((verb) => hasWholeWord(name, verb));
    }

    default:
      // Unknown action: gate it. New actions must opt in explicitly.
      return true;
  }
}

function hasSensitiveParams(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (SENSITIVE_URL_PARAMS.some((p) => url.searchParams.has(p))) return true;
    return SENSITIVE_URL_PARAMS.some((p) => url.pathname.toLowerCase().includes(p));
  } catch {
    // Unparseable URL — gate rather than assume it is harmless.
    return true;
  }
}
