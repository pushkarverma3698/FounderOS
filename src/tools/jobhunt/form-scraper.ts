/**
 * FounderOS — Multi-ATS Form Scraper
 * ==================================
 * Detects the ATS platform for a job URL, resolves the direct form URL,
 * reveals inert form tabs when required (Ashby, Recruitee, Personio,
 * SmartRecruiters, Teamtailor), and scrapes all visible/fillable fields
 * into the platform-agnostic `ScrapedField[]` structure consumed by `form-brain.ts`.
 */

import type { Locator, Page } from "playwright";
import { getApplyUrl } from "./apply-packet.js";
import type { ScrapedField, ScrapedFieldKind } from "./form-brain.js";

export type FormPlatform =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workable"
  | "recruitee"
  | "smartrecruiters"
  | "personio"
  | "teamtailor"
  | "bamboohr"
  | "generic";

/** Minimal structural DOM types for browser `evaluate` callbacks (Node tsconfig omits `lib: ["dom"]`). */
interface DomElement {
  readonly id: string;
  readonly name?: string;
  readonly tagName: string;
  readonly className: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly textContent: string | null;
  readonly parentElement: DomElement | null;
  readonly options?: ArrayLike<{ readonly textContent: string | null }>;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
  closest(selector: string): DomElement | null;
  querySelector(selector: string): DomElement | null;
}

interface DomGlobal {
  readonly document: {
    querySelector(selector: string): DomElement | null;
    querySelectorAll(selector: string): ArrayLike<DomElement>;
  };
  readonly CSS: { escape(ident: string): string };
}

const PLATFORM_HOST_MARKERS: ReadonlyArray<readonly [Exclude<FormPlatform, "generic">, readonly string[]]> = [
  ["greenhouse", ["greenhouse.io", "boards.greenhouse.io", "job-boards.greenhouse.io", "job-boards.eu.greenhouse.io"]],
  ["lever", ["lever.co", "jobs.lever.co", "jobs.eu.lever.co"]],
  ["ashby", ["ashbyhq.com", "jobs.ashbyhq.com"]],
  ["workable", ["workable.com", "apply.workable.com"]],
  ["recruitee", ["recruitee.com"]],
  ["smartrecruiters", ["smartrecruiters.com", "jobs.smartrecruiters.com"]],
  ["personio", ["personio.com", "personio.de"]],
  ["teamtailor", ["teamtailor.com"]],
  ["bamboohr", ["bamboohr.com"]],
];

const UNSUPPORTED_HOST_REASONS: ReadonlyArray<readonly [string, string]> = [
  ["myworkdayjobs.com", "Workday requires per-company account creation and multi-step login"],
  ["jobicy.com", "Jobicy is an aggregator page without an embedded application form"],
  ["arbeitnow.com", "Arbeitnow is an aggregator page without an embedded application form"],
  ["linkedin.com", "LinkedIn requires an authenticated browser session"],
];

export type PlatformCheck =
  | { readonly supported: true; readonly platform: FormPlatform }
  | { readonly supported: false; readonly reason: string };

/** Classify a job URL into a supported ATS platform or an explicit unsupported reason. */
export function classifyFormUrl(url: string): PlatformCheck {
  const lowered = (url || "").trim().toLowerCase();
  if (!lowered || !/^https?:\/\//.test(lowered)) {
    return { supported: false, reason: "no valid http(s) URL on file for this role" };
  }
  for (const [marker, reason] of UNSUPPORTED_HOST_REASONS) {
    if (lowered.includes(marker)) return { supported: false, reason };
  }
  for (const [platform, markers] of PLATFORM_HOST_MARKERS) {
    if (markers.some((m) => lowered.includes(m))) {
      return { supported: true, platform };
    }
  }
  return { supported: true, platform: "generic" };
}

/** Resolve the direct URL where the application form is rendered. */
export function resolveFormTargetUrl(url: string, company: string, platform: FormPlatform): string {
  const mapped = getApplyUrl(url, company);
  if (mapped) return mapped;
  if (platform === "ashby") {
    try {
      const u = new URL(url);
      if (!u.pathname.endsWith("/application")) {
        u.pathname = `${u.pathname.replace(/\/$/, "")}/application`;
      }
      return u.toString();
    } catch {
      return url;
    }
  }
  return url;
}

function cssEscapeAttr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Use `[id="..."]` so dots/colons in Recruitee or React IDs never break CSS parsing. */
export function idSelector(id: string): string {
  return `[id="${cssEscapeAttr(id)}"]`;
}

async function labelForElement(page: Page, el: Locator, id: string): Promise<string> {
  if (id) {
    // allow-failopen: missing label[for] is normal; falls through to aria-label/placeholder/ancestor.
    const viaFor = await page.locator(`label[for="${cssEscapeAttr(id)}"]`).first().textContent().catch(() => null);
    if (viaFor?.trim() && !/^(attach|upload|clear|remove|browse|choose file)$/i.test(viaFor.trim())) {
      return viaFor.trim().replace(/\s+/g, " ");
    }
  }
  // allow-failopen: falls through to next label strategy.
  const ariaLabel = await el.getAttribute("aria-label").catch(() => null);
  if (ariaLabel?.trim()) return ariaLabel.trim().replace(/\s+/g, " ");
  // allow-failopen: falls through to ancestor lookup.
  const placeholder = await el.getAttribute("placeholder").catch(() => null);
  if (placeholder?.trim() && !/^(select|type here|enter|choose|\.\.\.)/i.test(placeholder.trim())) {
    return placeholder.trim().replace(/\s+/g, " ");
  }
  return el
    .evaluate((node) => {
      let n: DomElement | null = node as unknown as DomElement;
      for (let i = 0; i < 6 && n; i++) {
        n = n.parentElement;
        if (!n) break;
        const candidate = n.querySelector("legend, label, strong, [class*='label' i]");
        const text = candidate?.textContent?.trim().replace(/\s+/g, " ");
        if (text && text.length > 1 && text.length < 220 && !/^(clear|remove|attach|upload)$/i.test(text)) {
          return text;
        }
      }
      return "";
    })
    // allow-failopen: unlabelled field defaults to "" and maps to `ask` in form-brain.
    .catch(() => "");
}

function isConsentByHeuristic(name: string, id: string, label: string): boolean {
  return /gdpr|consent|privacy|terms|agree|acknowledge|gegevens|toestemming/i.test(`${name} ${id} ${label}`);
}

async function groupLabelFor(page: Page, name: string): Promise<string> {
  return page
    .locator(`input[name="${cssEscapeAttr(name)}"]`)
    .first()
    .evaluate((node) => {
      let n: DomElement | null = node as unknown as DomElement;
      for (let i = 0; i < 8 && n; i++) {
        n = n.parentElement;
        if (!n) break;
        const legend = n.querySelector("legend, [class*='label' i]:not(input):not(select):not(textarea)");
        const text = legend?.textContent?.trim().replace(/\s+/g, " ");
        if (text && text.length > 4 && text.length < 250 && !/^(clear|remove)$/i.test(text)) return text;
      }
      return "";
    })
    // allow-failopen: falls back to option-level label.
    .catch(() => "");
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
  const raw = await page.evaluate(() => {
    const dom = globalThis as unknown as DomGlobal;
    const els = Array.from(dom.document.querySelectorAll("input, select, textarea"));
    return els.map((e, idx) => {
      const rect = e.getBoundingClientRect();
      const rawType = (e.getAttribute("type") ?? (e.tagName === "TEXTAREA" ? "textarea" : e.tagName === "SELECT" ? "select" : "text")).toLowerCase();
      const isVisible = rawType === "file" || (rect.width > 0 && rect.height > 0);
      const isCaptcha =
        /recaptcha|h-captcha|hcaptcha|cf-turnstile/i.test(e.className || "") ||
        /recaptcha|h-captcha|cf-turnstile/i.test(e.getAttribute("name") ?? "") ||
        !!e.closest('[class*="recaptcha" i], [class*="captcha" i], [class*="turnstile" i]');

      let optText = "";
      if (rawType === "checkbox" || rawType === "radio") {
        if (e.id) {
          const lbl = dom.document.querySelector(`label[for="${dom.CSS.escape(e.id)}"]`);
          if (lbl?.textContent?.trim()) optText = lbl.textContent.trim().replace(/\s+/g, " ");
        }
        if (!optText) {
          let n: DomElement | null = e.parentElement;
          for (let i = 0; i < 5 && n; i++) {
            const text = n.textContent?.trim().replace(/\s+/g, " ") ?? "";
            if (text.length > 0 && text.length < 300) {
              optText = text;
              break;
            }
            n = n.parentElement;
          }
        }
      }

      return {
        idx,
        tag: e.tagName,
        type: rawType,
        role: (e.getAttribute("role") ?? "").toLowerCase(),
        name: e.name || e.getAttribute("name") || "",
        id: e.id || "",
        required: Boolean(e.required) || e.getAttribute("aria-required") === "true",
        value: optText,
        isCaptcha,
        hasFormAttr: !!e.closest("form, [role='form'], #application-form, #application_form, #app"),
        isVisible,
      };
    });
  });

  const fields: ScrapedField[] = [];
  const groupedNames = new Set<string>();

  for (const r of raw) {
    if (platform !== "ashby" && !r.hasFormAttr) continue;
    if (r.type === "hidden" || r.type === "submit" || r.type === "button" || r.type === "reset" || r.type === "search") continue;
    if (!r.isVisible && r.type !== "file" && r.type !== "checkbox" && r.type !== "radio") continue;
    if (r.type !== "radio" && r.type !== "checkbox" && !r.name && !r.id) continue;
    if (/^react-select-\d+-input$/i.test(r.id) && !r.name) continue;

    const locator = page.locator("input, select, textarea").nth(r.idx);
    const label = await labelForElement(page, locator, r.id);

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
      const groupLabel = r.name ? await groupLabelFor(page, r.name) : "";
      const resolvedLabel = groupLabel || label || r.value;
      if (r.type === "checkbox" && isConsentByHeuristic(r.name, r.id, resolvedLabel)) {
        fields.push({
          selector,
          type: "checkbox",
          label: resolvedLabel,
          required: r.required,
          options: options.length > 0 ? options : ["Yes, accept"],
          isConsent: true,
        });
        continue;
      }

      fields.push({
        selector,
        type: r.type === "radio" ? "radio-group" : "checkbox-group",
        label: resolvedLabel,
        required: r.required,
        options,
      });
      continue;
    }

    const kind: ScrapedFieldKind =
      r.type === "file" ? "file"
      : r.type === "email" ? "email"
      : r.type === "tel" ? "tel"
      : r.type === "number" ? "number"
      : r.tag === "TEXTAREA" ? "textarea"
      : r.tag === "SELECT" ? "select"
      : "text";

    let options: string[] | undefined;
    if (kind === "select") {
      options = await locator
        .evaluate((el) => Array.from((el as unknown as DomElement).options ?? []).map((o) => o.textContent?.trim() ?? ""))
        // allow-failopen: unreadable select options fall back to `ask` in form-brain.
        .catch(() => undefined);
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

    const requiredFromLabel = /\*\s*$/.test(effectiveLabel);
    fields.push({
      selector: r.id ? idSelector(r.id) : `${r.tag.toLowerCase()}[name="${cssEscapeAttr(r.name)}"]`,
      type: kind,
      label: effectiveLabel,
      required: r.required || requiredFromLabel,
      options,
    });
  }

  return fields;
}
