/**
 * Guards around a form fill that hold on every platform.
 * Lever, Greenhouse and Ashby parse an uploaded CV and overwrite fields we already typed. On 2026-11-15 Lever turned
 * a verified LinkedIn URL into "http://linkedin.com/in/pushkar-". So files go first, the page settles, and every
 * typed value is checked again at the end.
 */
import type { Page } from "playwright";
import type { FormFillAction } from "./form-brain.js";
import { fieldHoldsValue } from "./form-phone.js";

/** File uploads first, so CV parsing runs before we type anything. */
export function filesFirst(actions: readonly FormFillAction[]): FormFillAction[] {
  return [...actions.filter((a) => a.kind === "file"), ...actions.filter((a) => a.kind !== "file")];
}

/** Call before each action: before the first non-file action after an upload, wait for CV parsing once. */
export function settleOnceAfterUploads(page: Page, actions: readonly FormFillAction[]): (next: FormFillAction) => Promise<void> {
  let settled = !actions.some((a) => a.kind === "file");
  return async (next) => {
    if (settled || next.kind === "file") return;
    settled = true;
    // allow-failopen: a page that never goes idle still gets the fixed settle.
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
  };
}

/**
 * Re-read each verified typed value. Retype a drifted one once. If it still drifts, drop it from `verified`, so it is
 * never reported as filled. Comboboxes are skipped: the visible value is the chosen suggestion, not the typed text.
 */
export async function recheckTypedValues(
  page: Page,
  actions: readonly FormFillAction[],
  verified: Set<string>,
  retype: (selector: string, value: string) => Promise<boolean>,
): Promise<void> {
  for (const a of actions) {
    if (a.kind !== "value" || !verified.has(a.selector)) continue;
    const loc = page.locator(a.selector).first();
    // allow-failopen: an unreadable role counts as a plain input.
    const role = await loc.getAttribute("role").catch(() => null);
    if (role?.toLowerCase() === "combobox") continue;
    // allow-failopen: an unreadable value counts as drifted and gets one retype.
    if (await fieldHoldsValue(loc, a.value).catch(() => false)) continue;
    // allow-failopen: a retype that throws leaves the field unverified, which routes it to the founder.
    if (!(await retype(a.selector, a.value).catch(() => false))) verified.delete(a.selector);
  }
}
