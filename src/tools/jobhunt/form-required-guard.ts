/**
 * FounderOS — Last check before Submit: a visible input whose label ends with `*` must not be empty.
 * Ashby marks required questions only with that star (no required attribute, no <form>), so native
 * checkValidity cannot see them and a click on Submit fails silently (2026-10-19, Mollie Location).
 */

import type { Page } from "playwright";

interface El {
  readonly id: string;
  readonly value?: string;
  readonly parentElement: El | null;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
  closest(selector: string): El | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
}
interface Dom {
  readonly document: { querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };
  readonly CSS: { escape(ident: string): string };
}

/** Labels (with their star) of visible, empty, required-by-label text fields. Empty when the page cannot be read. */
export async function emptyStarredFields(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const dom = globalThis as unknown as Dom;
      const clean = (s: string | null | undefined): string => (s ?? "").trim().replace(/\s+/g, " ");
      const FILLABLE =
        'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]), textarea, select';
      const labelFor = (e: El): string => {
        const viaFor = e.id ? clean(dom.document.querySelector(`label[for="${dom.CSS.escape(e.id)}"]`)?.textContent) : "";
        if (viaFor) return viaFor;
        // Climb while this input is the only fillable one in the container, so a neighbour's label is never read.
        for (let n = e.parentElement, i = 0; n && i < 6 && n.querySelectorAll(FILLABLE).length === 1; n = n.parentElement, i++) {
          const t = clean(n.querySelector("legend, label, [class*='label' i]")?.textContent);
          if (t.length > 1 && t.length < 220) return t;
        }
        return clean(e.getAttribute("aria-label"));
      };
      const out: string[] = [];
      for (const e of Array.from(dom.document.querySelectorAll(FILLABLE))) {
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || clean(e.value) !== "") continue;
        const control = e.closest('[class*="control" i]');
        if (clean(control?.querySelector('[class*="single-value" i], [class*="singleValue" i]')?.textContent) !== "") continue;
        const label = labelFor(e);
        if (/[*✱]\s*$/.test(label)) out.push(label);
      }
      return out;
    })
    // allow-failopen: an unreadable page cannot prove a field empty; the existing validity and outcome checks still run.
    .catch(() => [] as string[]);
}
