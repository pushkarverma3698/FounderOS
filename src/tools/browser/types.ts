/**
 * FounderOS — Browser Control Contracts
 * =====================================
 * Shared shapes for the accessibility-tree browser driver.
 *
 * The agent acts on `ref` ids drawn from a snapshot, never on CSS selectors.
 * A page that reflows therefore cannot cause a mis-click, and a ref that no
 * longer exists fails loudly instead of resolving to the wrong element.
 */

/** Actions the agent may request. */
export type BrowserAction =
  | "navigate"
  | "snapshot"
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "wait_for"
  | "screenshot"
  | "back";

/** One interactive element in an accessibility snapshot. */
export interface Ref {
  /** Stable within a single snapshot, e.g. "ref_7". */
  ref: string;
  /** ARIA role: button, link, textbox, checkbox, combobox, … */
  role: string;
  /** Accessible name — what a screen reader would announce. */
  name: string;
  /** Current value, for form controls. */
  value?: string;
  /** True when the element is a password / credential field. */
  secure?: boolean;
  /** True when activating this element submits a form. */
  submits?: boolean;
  /** True when the element is disabled and cannot be acted on. */
  disabled?: boolean;
}

export interface BrowserRequest {
  action: BrowserAction;
  /** Target element, for click / type / select / wait_for. */
  ref?: string;
  /** URL for navigate. */
  url?: string;
  /** Text for type, option for select. */
  text?: string;
  /** Scroll delta in pixels; negative scrolls up. */
  amount?: number;
}

export interface BrowserResult {
  ok: boolean;
  url: string;
  title: string;
  /** Interactive elements only — static text lives in `text`. */
  snapshot: Ref[];
  /** Page text, for read actions. */
  text?: string;
  /** Base64 PNG, only for the screenshot action. */
  image?: string;
  /** Operator-facing note, e.g. a detected login wall. */
  notice?: string;
  error?: string;
  /** Whether a failed action is worth retrying. */
  retryable?: boolean;
}
