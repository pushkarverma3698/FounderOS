/**
 * FounderOS — Shared headless Chromium lifecycle
 * ================================================
 * ONE Chromium process for every browser consumer in the kernel. Extracted from
 * browser-playwright.ts (which keeps its exported surface) so the UI-QA checker
 * does not launch a second browser alongside the `browser` agent tool.
 *
 * Two access shapes, because the two callers need opposite things:
 *
 *   getPage()        — the STATEFUL singleton page. `open_url` then
 *                      `get_page_text` must read the same page, matching the
 *                      Safari/AppleScript behaviour the `browser` tool exposes.
 *   withFreshPage()  — an ISOLATED page, closed on exit. ui-check attaches
 *                      console/network listeners per target; on a shared page
 *                      one target's errors would be reported against the next.
 *
 * Both share the browser process, which is the expensive part (~300ms launch).
 *
 * Setup (one-time): npx playwright install chromium
 */

import type { Browser, Page } from "playwright";

/** Cap on text extracted from a page. Mirrors browser-playwright.ts. */
export const MAX_CHARS = 100_000;

/** Default viewports for UI checks: desktop and phone. */
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

let _browser: Browser | null = null;
let _page: Page | null = null;

/**
 * Launch flags are load-bearing on the VPS, not cosmetic:
 *   --no-sandbox / --disable-setuid-sandbox — Ubuntu VPS has no kernel user namespace
 *   --disable-dev-shm-usage                 — prevents /dev/shm overflow in low-memory containers
 */
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 FounderOS/1.0";

/** The shared browser process. Launched lazily so importing this costs nothing. */
export async function getBrowser(): Promise<Browser> {
  if (!_browser) {
    const { chromium } = await import("playwright");
    _browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  }
  return _browser;
}

/** The stateful singleton page — `open_url` then `get_page_text` read the same page. */
export async function getPage(): Promise<Page> {
  const browser = await getBrowser();
  if (!_page || _page.isClosed()) {
    _page = await browser.newPage();
    await _page.setExtraHTTPHeaders({ "User-Agent": USER_AGENT });
  }
  return _page;
}

/**
 * Run `fn` against a fresh, isolated page and always close it.
 *
 * The page is closed in a `finally` so a throwing `fn` cannot leak a page into
 * the shared browser — a leak would accumulate across a multi-target QA run and
 * eventually exhaust the container's memory.
 */
export async function withFreshPage<T>(
  fn: (page: Page) => Promise<T>,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<T> {
  const browser = await getBrowser();
  const page = await browser.newPage({
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    userAgent: USER_AGENT,
  });
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => undefined); // allow-failopen: page already gone is not an error worth failing the run
  }
}

/** Resize the current singleton page. */
export async function setViewport(width: number, height: number): Promise<void> {
  const page = await getPage();
  await page.setViewportSize({ width, height });
}

/**
 * Screenshot a page as PNG bytes.
 *
 * `fullPage` defaults true: a viewport-only shot of a broken page often looks
 * fine because the breakage is below the fold, which is exactly the defect class
 * this whole gate exists to catch.
 */
export async function screenshot(
  page: Page,
  opts: { fullPage?: boolean } = {},
): Promise<Buffer> {
  return page.screenshot({ fullPage: opts.fullPage ?? true, type: "png" });
}

/** Wait for a selector to appear. Returns false on timeout rather than throwing. */
export async function waitFor(
  page: Page,
  selector: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Gracefully close the shared browser. Call on process exit and between tests. */
export async function closeBrowser(): Promise<void> {
  if (_page && !_page.isClosed()) await _page.close().catch(() => undefined); // allow-failopen: teardown must not throw
  if (_browser) await _browser.close().catch(() => undefined); // allow-failopen: teardown must not throw
  _browser = null;
  _page = null;
}
