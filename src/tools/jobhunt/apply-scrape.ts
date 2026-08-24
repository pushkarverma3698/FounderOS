/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * FounderOS — reading a real application form
 * ==============================================
 * The read half of `apply_headless`'s Playwright driver: which platform a
 * posting belongs to, and turning its live DOM into the flat `FormField[]`
 * shape `apply-fill.ts`'s `buildFillPlan` consumes.
 *
 * Split out of apply-driver.ts on 2026-08-24 when that file crossed its
 * 400-line budget — same precedent as brief-select.ts/brief-actions.ts: the
 * read side (this file) and the act side (apply-driver.ts: fill, screenshot,
 * submit) are genuinely separate concerns that happened to grow in the same
 * file because they were built in the same session.
 *
 * NOT UNIT-TESTED AT THIS LAYER, DELIBERATELY, matching `cv-renderer.ts`'s own
 * precedent: a function that only wraps Playwright Page calls has nothing pure
 * to assert without a live or fully-mocked browser. What IS tested is
 * `apply-fill.ts`'s decision core, against real field lists captured from
 * these five platforms — see `tests/unit/jobhunt/apply-fill.test.ts` and
 * `tests/fixtures/apply-forms/`.
 */

import type { Page } from "playwright";
import type { FormField, FieldKind } from "./apply-fill.js";

export type SupportedAts = "greenhouse" | "lever" | "ashby" | "workable" | "recruitee";

/** Platforms `apply_headless` can drive. Everything else falls back to `/draft`. */
const ATS_HOST_MARKERS: ReadonlyArray<readonly [SupportedAts, readonly string[]]> = [
  ["greenhouse", ["greenhouse.io"]],
  ["lever", ["jobs.lever.co", "lever.co"]],
  ["ashby", ["jobs.ashbyhq.com", "ashbyhq.com"]],
  ["workable", ["workable.com"]],
  ["recruitee", [".recruitee.com"]],
];

/**
 * Which platform a posting URL belongs to, or null when it is not one v1
 * supports — Workday included, on purpose (see the design doc: Workday's
 * apply flow is a multi-page wizard that frequently gates on account
 * creation, a different problem than filling fields on one page).
 */
export function detectApplyAts(url: string): SupportedAts | null {
  const lowered = (url || "").toLowerCase();
  for (const [ats, markers] of ATS_HOST_MARKERS) {
    if (markers.some((m) => lowered.includes(m))) return ats;
  }
  return null;
}

function cssEscapeName(s: string): string {
  return s.replace(/"/g, '\\"');
}

/**
 * An id-based selector, as an ATTRIBUTE selector rather than `#id`.
 *
 * REGRESSION, found by live-testing against Recruitee (2026-08-24): its real
 * DOM ids look like `input-candidate.name-3` — a literal dot. `#id` syntax
 * means the dot is a CSS token, not a character, so `#input-candidate.name-3`
 * parses as "id=input-candidate AND class=name-3", which matches nothing. The
 * form scraped 6 fields and every single fill silently timed out, because
 * `#${cssEscapeName(id)}` only ever escaped double quotes — never the far more
 * common case of a dot, colon, or bracket inside a generated id. `[id="..."]`
 * needs no per-character escaping beyond the quote this file already handles.
 */
function idSelector(id: string): string {
  return `[id="${cssEscapeName(id)}"]`;
}

async function labelFor(page: Page, el: import("playwright").Locator, id: string): Promise<string> {
  if (id) {
    // allow-failopen: no label[for] is the ordinary case, not an error — falls through to the next lookup.
    const viaFor = await page.locator(`label[for="${cssEscapeName(id)}"]`).first().textContent().catch(() => null);
    if (viaFor?.trim()) return viaFor.trim();
  }
  // allow-failopen: same reasoning — an absent source falls through; a fully unlabelled field still gets `ask` (the safe default).
  const ariaLabel = await el.getAttribute("aria-label").catch(() => null);
  if (ariaLabel?.trim()) return ariaLabel.trim();
  // allow-failopen: same reasoning as above.
  const placeholder = await el.getAttribute("placeholder").catch(() => null);
  if (placeholder?.trim()) return placeholder.trim();
  // Walk up a few levels for a nearby label/legend/strong — the shape Ashby
  // and Workable both use for their custom questions (verified live, 2026-08-24).
  return el
    .evaluate((node) => {
      let n: HTMLElement | null = node as HTMLElement;
      for (let i = 0; i < 6 && n; i++) {
        n = n.parentElement;
        if (!n) break;
        const candidate = n.querySelector("legend, strong, label");
        const text = candidate?.textContent?.trim();
        if (text && text.length > 1 && text.length < 200 && !/^(clear|remove)$/i.test(text)) return text;
      }
      return "";
    })
    // allow-failopen: an unlabelled field falls to `ask` in buildFillPlan — never guessed at, never silently filled.
    .catch(() => "");
}

/**
 * Read every fillable field on the current page into the flat shape
 * `buildFillPlan` consumes. Radio/checkbox groups sharing one `name` collapse
 * into ONE field with `options` — the shape a real Greenhouse/Workable
 * multi-choice question always takes.
 */
export async function scrapeFormFields(page: Page, ats: SupportedAts): Promise<FormField[]> {
  const raw = await page.evaluate(() => {
    const isCaptcha = (el: Element): boolean =>
      /recaptcha|h-captcha|hcaptcha/i.test(el.className) ||
      /recaptcha|h-captcha/i.test(el.getAttribute("name") ?? "") ||
      !!el.closest('[class*="recaptcha" i], [class*="captcha" i]');

    // The option's own visible text — NOT via nextElementSibling. Verified
    // live on Greenhouse (2026-08-24): a checkbox's next sibling is an <svg>
    // check-icon, not text, so that lookup always returned "". The real text
    // lives two ancestors up (input → .checkbox__input → .checkbox__wrapper,
    // whose OWN textContent is exactly "Netherlands, already authorized to
    // work here" — nothing from sibling options bleeds in at that level).
    // Climbing to the first ancestor with non-empty text generalises this
    // without hard-coding Greenhouse's class names, and the length cap keeps
    // it from accidentally walking all the way up to the fieldset, whose text
    // is every option concatenated.
    const optionText = (input: HTMLInputElement): string => {
      let n: HTMLElement | null = input.parentElement;
      for (let i = 0; i < 5 && n; i++) {
        const text = n.textContent?.trim() ?? "";
        if (text.length > 0 && text.length < 300) return text;
        n = n.parentElement;
      }
      return "";
    };

    const els = [...document.querySelectorAll("input, select, textarea")] as HTMLInputElement[];
    return els.map((e, idx) => ({
      idx,
      tag: e.tagName,
      type: (e.getAttribute("type") ?? (e.tagName === "TEXTAREA" ? "textarea" : e.tagName === "SELECT" ? "select" : "text")).toLowerCase(),
      name: e.name || "",
      id: e.id || "",
      required: e.required,
      value: e.type === "checkbox" || e.type === "radio" ? optionText(e) : "",
      isCaptcha: isCaptcha(e),
      hasFormAttr: !!e.closest("form"),
    }));
  });

  const fields: FormField[] = [];
  const groupedNames = new Set<string>();

  for (const r of raw) {
    // Stray inputs outside the actual application form — EXCEPT on Ashby,
    // which has no <form> element on the page at all (confirmed live,
    // 2026-08-24: 46 genuine fields, zero `document.querySelectorAll("form")`
    // matches, on the real Altura/application posting). Every field on an
    // Ashby application route belongs to the application; there is no
    // sibling widget on that route to accidentally pick up.
    if (ats !== "ashby" && !r.hasFormAttr) continue;
    if (r.type === "hidden" || r.type === "submit" || r.type === "button") continue;
    // Neither name nor id: no selector can ever target this element again.
    // Found live on Greenhouse (gitlab, reltio postings, 2026-08-24): the
    // country autocomplete renders a second, nameless/idless auxiliary input
    // next to the real `id="country"` field. Without this skip it fell
    // through to `input[name=""]` — a selector that can never match the
    // right element — and surfaced as a phantom duplicate "Country*" in the
    // unanswered list on every single fill attempt, never once fillable.
    if (r.type !== "radio" && r.type !== "checkbox" && !r.name && !r.id) continue;

    const locator = page.locator("input, select, textarea").nth(r.idx);
    const label = await labelFor(page, locator, r.id);

    if (r.isCaptcha) {
      fields.push({ selector: r.id ? idSelector(r.id) : `input[name="${cssEscapeName(r.name)}"]`, type: "captcha", label: "", required: false, isCaptcha: true });
      continue;
    }

    if (r.type === "radio" || r.type === "checkbox") {
      if (!r.name) continue; // no way to group or re-select it later
      const groupKind: FieldKind = r.type === "radio" ? "radio-group" : "checkbox-group";
      const isConsentField = r.type === "checkbox" && isConsentByHeuristic(r.name, r.id, label);
      if (isConsentField) {
        fields.push({ selector: `input[name="${cssEscapeName(r.name)}"]`, type: "checkbox", label, required: false, isConsent: true });
        continue;
      }
      if (groupedNames.has(r.name)) continue; // options collected on first sight of the group
      groupedNames.add(r.name);
      const options = raw
        .filter((o) => o.name === r.name && (o.type === "radio" || o.type === "checkbox"))
        .map((o) => o.value)
        .filter(Boolean);
      const groupLabel = await groupLabelFor(page, r.name);
      fields.push({
        selector: `input[name="${cssEscapeName(r.name)}"]`,
        type: groupKind,
        label: groupLabel || label,
        required: r.required,
        options,
      });
      continue;
    }

    const kind: FieldKind =
      r.type === "file" ? "file"
      : r.type === "email" ? "email"
      : r.type === "tel" ? "tel"
      : r.type === "number" ? "number"
      : r.tag === "TEXTAREA" ? "textarea"
      : r.tag === "SELECT" ? "select"
      : "text";

    let options: string[] | undefined;
    if (kind === "select") {
      // A select whose options cannot be read scrapes as optionless; buildFillPlan's choice-type gate then falls to `ask`.
      // allow-failopen: one unreadable dropdown must not abort scraping the rest of the form.
      options = await locator.evaluate((el) => [...(el as HTMLSelectElement).options].map((o) => o.textContent?.trim() ?? "")).catch(() => undefined);
    }

    fields.push({
      selector: r.id ? idSelector(r.id) : `${r.tag.toLowerCase()}[name="${cssEscapeName(r.name)}"]`,
      type: kind,
      label,
      required: r.required,
      options,
    });
  }

  return fields;
}

function isConsentByHeuristic(name: string, id: string, label: string): boolean {
  return /gdpr|consent|privacy|terms|agree/i.test(`${name} ${id} ${label}`);
}

async function groupLabelFor(page: Page, name: string): Promise<string> {
  return page
    .locator(`input[name="${cssEscapeName(name)}"]`)
    .first()
    .evaluate((node) => {
      let n: HTMLElement | null = node as HTMLElement;
      for (let i = 0; i < 8 && n; i++) {
        n = n.parentElement;
        if (!n) break;
        const legend = n.querySelector("legend, [class*='label' i]:not(input):not(select):not(textarea)");
        const text = legend?.textContent?.trim();
        if (text && text.length > 5 && text.length < 250 && !/^(clear|remove)$/i.test(text)) return text;
      }
      return "";
    })
    // allow-failopen: an unreadable legend falls back to the per-option label the caller already has (`groupLabel || label`).
    .catch(() => "");
}
