/**
 * FounderOS — Multi-ATS Form Scraper
 * ==================================
 * Detects the ATS platform for a job URL, resolves the direct form URL,
 * reveals inert form tabs when required (Ashby, Recruitee, Personio,
 * SmartRecruiters, Teamtailor), and scrapes all visible/fillable fields
 * into the platform-agnostic `ScrapedField[]` structure consumed by `form-brain.ts`.
 */

import type { Page } from "playwright";
import type { ScrapedField, ScrapedFieldKind } from "./form-brain.js";
import { classifyFormUrl, resolveFormTargetUrl, type FormPlatform } from "./form-platform.js";
import { cssEscapeAttr, idSelector, installEvaluateShim, readComboboxOptions, stampSelector } from "./form-combobox.js";


export { classifyFormUrl, resolveFormTargetUrl, type FormPlatform, type PlatformCheck } from "./form-platform.js";

/** Minimal structural DOM types for browser `evaluate` callbacks (Node tsconfig omits `lib: ["dom"]`). */
interface DomElement {
  readonly id: string;
  readonly nodeType: number;
  readonly nodeName: string;
  readonly childNodes: ArrayLike<DomElement>;
  readonly name?: string;
  readonly tagName: string;
  readonly className: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly textContent: string | null;
  readonly parentElement: DomElement | null;
  readonly options?: ArrayLike<{ readonly textContent: string | null }>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
  closest(selector: string): DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

interface DomGlobal {
  readonly document: {
    getElementById(id: string): DomElement | null;
    querySelector(selector: string): DomElement | null;
    querySelectorAll(selector: string): ArrayLike<DomElement>;
  };
  readonly CSS: { escape(ident: string): string };
}


function isConsentByHeuristic(name: string, id: string, label: string): boolean {
  return /gdpr|consent|privacy|terms|agree|acknowledge|gegevens|toestemming/i.test(`${name} ${id} ${label}`);
}

/** Reveal the application form on platforms that require hydration or an in-page button click. */
export async function revealPlatformForm(page: Page, platform: FormPlatform): Promise<void> {
  if (platform === "ashby") {
    await page
      .locator('[id="_systemfield_name"], [name="_systemfield_name"], input[type="file"]')
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      // allow-failopen: scrapePageFields still runs if hydration times out.
      .catch(() => undefined);
    return;
  }

  if (platform === "greenhouse" || platform === "lever" || platform === "workable") {
    await page
      .locator('#first_name, #firstname, input[name="name"], input[type="email"], input[type="file"]')
      .first()
      .waitFor({ state: "attached", timeout: 8_000 })
      // allow-failopen: scrapePageFields still runs and reports accurately.
      .catch(() => undefined);
    return;
  }

  // allow-failopen: networkidle is best-effort before checking inputs.
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);

  // Recruitee on the employer's own domain (tsg.careers, 2026-10-20): the job page /o/<slug> holds the form hidden
  // behind a tab, and only /o/<slug>/c/new shows it.
  const here = new URL(page.url());
  const recruiteeForm = page.locator("form#offer-application-form");
  // allow-failopen: an unreadable form state leaves the page as it is.
  const hiddenForm = (await recruiteeForm.count().catch(() => 0)) > 0 && !(await recruiteeForm.first().isVisible().catch(() => true));
  if (/^\/o\/[^/]+\/?$/.test(here.pathname) && hiddenForm) {
    here.pathname = `${here.pathname.replace(/\/$/, "")}/c/new`;
    await page.goto(here.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    // allow-failopen: scrapePageFields runs next and reports what it finds.
    await page.locator('input[name="candidate.name"]').first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
    return;
  }

  const visibleInputs = await page
    .locator('input[type="email"]:visible, input[type="text"]:visible, input[type="file"]')
    .count()
    // allow-failopen: 0 triggers the reveal click below.
    .catch(() => 0);

  if (visibleInputs === 0 || platform === "recruitee") {
    const clicked = await page
      .getByRole("button", { name: /^(apply|apply now|i'm interested|solliciteer|solliciteren)$/i })
      .or(page.getByText(/^(Apply|Apply now|I'm interested|Solliciteer)$/i))
      .last()
      .click({ timeout: 5_000 })
      .then(() => true)
      // allow-failopen: if no reveal button exists, scrape whatever is on the page.
      .catch(() => false);

    if (clicked) {
      await page
        .locator('input[name="candidate.name"], input[type="email"], input[type="text"]')
        .first()
        .waitFor({ state: "visible", timeout: 5_000 })
        // allow-failopen: scrapePageFields runs next regardless.
        .catch(() => undefined);
    }
  }
}

/** Scrape all fillable fields on the current page into `ScrapedField[]`. */
export async function scrapePageFields(page: Page, platform: FormPlatform): Promise<ScrapedField[]> {
  await installEvaluateShim(page);
  const raw = await page.evaluate(() => {
    const dom = globalThis as unknown as DomGlobal;
    const clean = (s: string | null | undefined): string => (s ?? "").trim().replace(/\s+/g, " ");
    const SKIP = /^(attach|upload|clear|remove|browse|choose file)$/i;
    // Text without <svg> content: Workable's icon-only label[for] would otherwise read "SVGs not supported by this browser."
    const textOf = (n: DomElement | null | undefined): string => {
      if (!n || n.nodeName.toLowerCase() === "svg") return "";
      if (n.nodeType !== 1) return n.textContent ?? "";
      return Array.from(n.childNodes).map(textOf).join("");
    };
    const forLabel = (e: DomElement): string =>
      e.id ? clean(textOf(dom.document.querySelector(`label[for="${dom.CSS.escape(e.id)}"]`))) : "";
    // Workable names every question only through aria-labelledby; the first id is the label, later ids are hints.
    const labelledBy = (e: DomElement | null | undefined): string => {
      for (const id of (e?.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
        const t = clean(textOf(dom.document.getElementById(id)));
        if (t) return t;
      }
      return "";
    };
    // Labels are read here, in one snapshot: a per-field locator wait cost 30 s for every field without label[for].
    const labelOf = (e: DomElement): string => {
      const viaFor = forLabel(e);
      if (viaFor && !SKIP.test(viaFor)) return viaFor;
      const named = labelledBy(e);
      if (named && !SKIP.test(named)) return named;
      const aria = clean(e.getAttribute("aria-label"));
      if (aria) return aria;
      const placeholder = clean(e.getAttribute("placeholder"));
      if (placeholder && !/^(select|type here|start typing|enter|choose|\.\.\.)/i.test(placeholder)) return placeholder;
      for (let n = e.parentElement, i = 0; n && i < 6; n = n.parentElement, i++) {
        for (const c of Array.from(n.querySelectorAll("legend, label, strong, [class*='label' i]"))) {
          const t = clean(textOf(c));
          if (t.length > 1 && t.length < 220 && !SKIP.test(t)) return t;
        }
      }
      return "";
    };
    const optionTextOf = (e: DomElement): string => {
      const viaFor = forLabel(e);
      if (viaFor) return viaFor;
      for (let n = e.parentElement, i = 0; n && i < 5; n = n.parentElement, i++) {
        const t = clean(n.textContent);
        if (t.length > 0 && t.length < 300) return t;
      }
      return "";
    };
    // A radio/checkbox group's question: the nearest label-like text that is not one of its own options.
    const groupOf = (e: DomElement, opts: readonly string[]): { label: string; required: boolean } | null => {
      const box = e.closest('[role="radiogroup"], [role="group"], fieldset');
      const named = labelledBy(box);
      if (named) return { label: named, required: box?.getAttribute("aria-required") === "true" };
      for (let n = e.parentElement, i = 0; n && i < 8; n = n.parentElement, i++) {
        for (const c of Array.from(n.querySelectorAll("legend, label, [class*='label' i]:not(input):not(select):not(textarea)"))) {
          const t = clean(textOf(c));
          if (t.length < 4 || t.length >= 250 || /^(clear|remove)$/i.test(t) || opts.includes(t)) continue;
          return { label: t, required: /[*✱]\s*$/.test(t) || /required/i.test(c.className || "") };
        }
      }
      return null;
    };

    const els = Array.from(dom.document.querySelectorAll("input, select, textarea"));
    let stamped = 0;
    const rows = els.map((e) => {
      const rect = e.getBoundingClientRect();
      const rawType = (e.getAttribute("type") ?? (e.tagName === "TEXTAREA" ? "textarea" : e.tagName === "SELECT" ? "select" : "text")).toLowerCase();
      const isChoice = rawType === "checkbox" || rawType === "radio";
      // Ashby's Location is a bare <input role=combobox placeholder="Start typing..."> with no name or id: stamp a handle the runner can find again.
      const bare = !isChoice && rawType !== "hidden" && !e.name && !e.id && rect.width > 0 && rect.height > 0 && labelOf(e) !== "";
      if (bare) e.setAttribute("data-fos-field", String(stamped));
      return {
        tag: e.tagName,
        type: rawType,
        role: (e.getAttribute("role") ?? "").toLowerCase(),
        name: e.name || e.getAttribute("name") || "",
        id: e.id || "",
        stamp: bare ? stamped++ : -1,
        label: labelOf(e),
        required: Boolean(e.required) || e.getAttribute("aria-required") === "true",
        value: isChoice ? optionTextOf(e) : "",
        options: e.tagName === "SELECT" ? Array.from(e.options ?? []).map((o) => clean(o.textContent)) : undefined,
        // Ashby Yes/No: the answer is a pressed sibling button; the hidden checkbox only mirrors "Yes".
        buttonOptions: isChoice ? Array.from(e.parentElement?.querySelectorAll(":scope > button[aria-pressed]") ?? []).map((b) => clean(textOf(b))) : [],
        group: null as { label: string; required: boolean } | null,
        isCaptcha:
          /recaptcha|h-captcha|hcaptcha|cf-turnstile/i.test(e.className || "") ||
          /recaptcha|h-captcha|cf-turnstile/i.test(e.getAttribute("name") ?? "") ||
          !!e.closest('[class*="recaptcha" i], [class*="captcha" i], [class*="turnstile" i]'),
        hasFormAttr: !!e.closest("form, [role='form'], #application-form, #application_form, #app"),
        isVisible: rawType === "file" || (rect.width > 0 && rect.height > 0),
      };
    });
    const groups = new Map<string, { label: string; required: boolean } | null>();
    rows.forEach((r, i) => {
      if (!r.name || (r.type !== "radio" && r.type !== "checkbox")) return;
      if (!groups.has(r.name)) {
        const opts = rows.filter((o) => o.name === r.name && o.type === r.type).map((o) => o.value);
        groups.set(r.name, groupOf(els[i]!, opts));
      }
      r.group = groups.get(r.name) ?? null;
    });
    return rows;
  });

  const fields: ScrapedField[] = [];
  const groupedNames = new Set<string>();

  for (const r of raw) {
    if (platform !== "ashby" && !r.hasFormAttr) continue;
    if (r.type === "hidden" || r.type === "submit" || r.type === "button" || r.type === "reset" || r.type === "search") continue;
    if (!r.isVisible && r.type !== "file" && r.type !== "checkbox" && r.type !== "radio") continue;
    if (r.type !== "radio" && r.type !== "checkbox" && !r.name && !r.id && r.stamp < 0) continue;
    if (/^react-select-\d+-input$/i.test(r.id) && !r.name) continue;

    const label = r.label;

    if (r.isCaptcha) {
      fields.push({
        selector: r.id ? idSelector(r.id) : `input[name="${cssEscapeAttr(r.name)}"]`,
        type: "captcha",
        label: label || "CAPTCHA",
        required: false,
        isCaptcha: true,
      });
      continue;
    }

    if (r.type === "radio" || r.type === "checkbox") {
      const groupKey = r.name || r.id;
      if (!groupKey) continue;
      const selector = r.name ? `input[type="${r.type}"][name="${cssEscapeAttr(r.name)}"]` : idSelector(r.id);
      const siblings = r.name ? raw.filter((o) => o.name === r.name && (o.type === "radio" || o.type === "checkbox")) : [r];

      if (r.buttonOptions.length >= 2 && r.name) {
        fields.push({
          selector: `div:has(> input[name="${cssEscapeAttr(r.name)}"]) > button[aria-pressed]`,
          type: "radio-group",
          label: r.group?.label || label,
          required: r.required || Boolean(r.group?.required),
          options: r.buttonOptions,
        });
        continue;
      }

      if (r.type === "checkbox" && siblings.length === 1 && isConsentByHeuristic(r.name, r.id, label || r.value)) {
        fields.push({
          selector,
          type: "checkbox",
          label: label || r.value || "Accept privacy / terms",
          required: r.required,
          options: [r.value || label || "Yes, accept"],
          isConsent: true,
        });
        continue;
      }

      if (groupedNames.has(groupKey)) continue;
      groupedNames.add(groupKey);
      const options = siblings.map((o) => o.value).filter(Boolean);
      const resolvedLabel = r.group?.label || label || r.value;
      const groupRequired = r.required || Boolean(r.group?.required);
      if (r.type === "checkbox" && isConsentByHeuristic(r.name, r.id, resolvedLabel)) {
        fields.push({
          selector,
          type: "checkbox",
          label: resolvedLabel,
          required: groupRequired,
          options: options.length > 0 ? options : ["Yes, accept"],
          isConsent: true,
        });
        continue;
      }

      fields.push({
        selector,
        type: r.type === "radio" ? "radio-group" : "checkbox-group",
        label: resolvedLabel,
        required: groupRequired,
        options,
      });
      continue;
    }

    let kind: ScrapedFieldKind =
      r.type === "file" ? "file"
      : r.type === "email" ? "email"
      : r.type === "tel" ? "tel"
      : r.type === "number" ? "number"
      : r.tag === "TEXTAREA" ? "textarea"
      : r.tag === "SELECT" ? "select"
      : "text";

    let options = r.options;
    if (kind === "text" && r.role === "combobox" && r.id) {
      // React-Select keeps its options in a listbox that exists only while open; a fixed list makes it a select.
      // allow-failopen: an unopenable combobox stays a text field and is typed into or asked.
      const listed = await readComboboxOptions(page, page.locator(idSelector(r.id))).catch(() => [] as string[]);
      if (listed.length > 0) {
        kind = "select";
        options = listed;
      }
    }

    const idOrName = `${r.id} ${r.name}`.toLowerCase();
    const effectiveLabel =
      kind === "file" && !/resume|cv|cover/i.test(label)
        ? /cover/i.test(idOrName)
          ? "Cover Letter"
          : /resume|cv/i.test(idOrName)
            ? "Resume/CV"
            : label
        : label;

    const requiredFromLabel = /[*✱]\s*$/.test(effectiveLabel);
    fields.push({
      selector: r.id ? idSelector(r.id) : r.stamp >= 0 ? stampSelector(r.stamp) : `${r.tag.toLowerCase()}[name="${cssEscapeAttr(r.name)}"]`,
      type: kind,
      label: effectiveLabel,
      required: r.required || requiredFromLabel,
      options,
    });
  }

  return fields;
}
