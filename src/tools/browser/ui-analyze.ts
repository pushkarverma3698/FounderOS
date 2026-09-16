/**
 * FounderOS — ui_check: the PURE half (facts → defects)
 * ======================================================
 * No I/O, no browser, no clock. Given what ./ui-facts.ts measured, decide what
 * is wrong with the page. Unit-tested with fixtures and no Chromium, mirroring
 * the collector/analyzer split in src/evolution/ (collect-telemetry.ts gathers
 * rows, analyzers/ are pure functions over them).
 *
 * Every `detail` states what was measured and what the measurement was, in words
 * a reader who has never opened the code can act on. An internal label nobody
 * defined is not information — docs/rules/SHARED-DIRECTIVES.md and CLAUDE.md
 * rule #26 both make that binding.
 */

import type { ViewportName } from "./chromium.js";

/** high = ships broken to a human · medium = real defect · low = tidiness. */
export type UiSeverity = "high" | "medium" | "low";

export const UI_DEFECT_KINDS = [
  "unsubstituted-placeholder",
  "page-error",
  "console-error",
  "failed-asset",
  "blank-page",
  "horizontal-overflow",
  "empty-section",
  "broken-image",
  "missing-title",
  "no-headings",
  "missing-h1",
  "render-failed",
] as const;
export type UiDefectKind = (typeof UI_DEFECT_KINDS)[number];

export interface UiDefect {
  readonly kind: UiDefectKind;
  readonly severity: UiSeverity;
  readonly detail: string;
}

/** Raw measurements from one render. Everything the analyzer is allowed to see. */
export interface PageFacts {
  readonly target: string;
  readonly url: string;
  readonly viewport: ViewportName;
  readonly title: string;
  readonly bodyText: string;
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly failedAssets: readonly { url: string; reason: string }[];
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly emptyBlocks: readonly string[];
  readonly brokenImages: readonly string[];
  readonly headingCount: number;
  readonly h1Count: number;
}

export interface UiCheckRow {
  readonly target: string;
  readonly url: string;
  readonly viewport: ViewportName;
  readonly ok: boolean;
  readonly defects: readonly UiDefect[];
  readonly screenshotPath?: string;
}

/** Matches a Handlebars-style placeholder left in rendered output. */
const PLACEHOLDER_RE = /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/g;

/** Below this many characters of visible text, the page rendered as blank. */
export const BLANK_PAGE_MIN_CHARS = 50;

/** Sub-pixel rounding means a 1-2px excess is not a real overflow. */
export const OVERFLOW_TOLERANCE_PX = 2;

/**
 * One failed asset produces TWO events in Playwright — an HTTP status from the
 * `response` listener and a net::ERR_ABORTED from `requestfailed` — so the raw
 * list double-counts every 404. Reported twice, a single missing stylesheet
 * reads as two separate problems and inflates the blocking count; measured on
 * the first true-negative run. First reason per URL wins: the HTTP status is
 * more informative than the abort that follows it.
 */
export function dedupeAssets(
  assets: readonly { url: string; reason: string }[],
): Array<{ url: string; reason: string }> {
  const seen = new Map<string, { url: string; reason: string }>();
  for (const a of assets) if (!seen.has(a.url)) seen.set(a.url, a);
  return [...seen.values()];
}

/** Assets whose failure changes what the visitor sees, not just what loads. */
export function assetSeverity(url: string): UiSeverity {
  return /\.(css|js|mjs)(\?|$)/i.test(url) ? "high" : "medium";
}

/** PURE. Facts in, defects out. */
export function analyzePageFacts(facts: PageFacts): UiDefect[] {
  const defects: UiDefect[] = [];

  const leftover = [
    ...new Set([
      ...(facts.bodyText.match(PLACEHOLDER_RE) ?? []),
      ...(facts.title.match(PLACEHOLDER_RE) ?? []),
    ]),
  ];
  if (leftover.length > 0) {
    defects.push({
      kind: "unsubstituted-placeholder",
      severity: "high",
      detail:
        `The page still shows ${leftover.length} template placeholder(s) that were never filled in: ` +
        `${leftover.join(", ")}. A visitor would read them literally. apply_cinematic_preset ` +
        `substitutes {{CLIENT}} only, so any other placeholder must be filled by whoever builds the page.`,
    });
  }

  for (const err of facts.pageErrors) {
    defects.push({
      kind: "page-error",
      severity: "high",
      detail: `The page threw an uncaught JavaScript error while loading: ${err}`,
    });
  }

  for (const err of facts.consoleErrors) {
    defects.push({
      kind: "console-error",
      severity: "medium",
      detail: `The browser console logged an error: ${err}`,
    });
  }

  for (const asset of dedupeAssets(facts.failedAssets)) {
    const severity = assetSeverity(asset.url);
    defects.push({
      kind: "failed-asset",
      severity,
      detail:
        `The page asked for ${asset.url} and did not get it (${asset.reason}). ` +
        (severity === "high"
          ? "A missing stylesheet or script means the visitor sees an unstyled or non-working page."
          : "The visitor sees a gap where this asset should be."),
    });
  }

  if (facts.bodyText.trim().length < BLANK_PAGE_MIN_CHARS) {
    defects.push({
      kind: "blank-page",
      severity: "high",
      detail:
        `The rendered page contains only ${facts.bodyText.trim().length} characters of visible text ` +
        `(anything under ${BLANK_PAGE_MIN_CHARS} reads as blank). The visitor would see an empty page.`,
    });
  }

  const overflow = facts.scrollWidth - facts.clientWidth;
  if (overflow > OVERFLOW_TOLERANCE_PX) {
    defects.push({
      kind: "horizontal-overflow",
      severity: "medium",
      detail:
        `Content is ${overflow}px wider than the ${facts.viewport} viewport ` +
        `(${facts.scrollWidth}px of content in a ${facts.clientWidth}px window), so the page scrolls sideways.`,
    });
  }

  for (const block of facts.emptyBlocks) {
    defects.push({
      kind: "empty-section",
      severity: "medium",
      detail:
        `The <${block}> block rendered with no height and no text — the section is in the markup ` +
        `but invisible to a visitor.`,
    });
  }

  for (const img of facts.brokenImages) {
    defects.push({
      kind: "broken-image",
      severity: "medium",
      detail: `The image ${img} failed to load and renders as a broken-image icon.`,
    });
  }

  if (facts.title.trim().length === 0) {
    defects.push({
      kind: "missing-title",
      severity: "medium",
      detail:
        "The page has no <title>, so the browser tab and every search or social preview show the bare URL.",
    });
  }

  if (facts.headingCount === 0) {
    defects.push({
      kind: "no-headings",
      severity: "medium",
      detail:
        "The page has no headings at all — nothing for a screen reader or a search engine to structure it by.",
    });
  } else if (facts.h1Count === 0) {
    // Checked separately from headingCount: a page can keep its <h2>s and still
    // have lost its <h1>, which is the headline a visitor and Google both read
    // first. The true-negative run caught exactly that gap.
    defects.push({
      kind: "missing-h1",
      severity: "medium",
      detail:
        `The page has ${facts.headingCount} heading(s) but no <h1> — it has lost its main headline, ` +
        `which is the first thing a visitor and a search engine read.`,
    });
  } else if (facts.h1Count > 1) {
    defects.push({
      kind: "missing-h1",
      severity: "low",
      detail: `The page has ${facts.h1Count} <h1> elements; exactly one main headline is expected.`,
    });
  }

  return defects;
}

/** A row is a pass only when nothing high-severity was found. */
export function rowIsOk(defects: readonly UiDefect[]): boolean {
  return !defects.some((d) => d.severity === "high");
}
