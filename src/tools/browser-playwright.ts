/**
 * FounderOS — Playwright Browser Backend
 * ========================================
 * Drop-in replacement for the AppleScript/Safari browser backend on Linux/Ubuntu VPS.
 * Uses headless Chromium via the Playwright API — no display server required.
 *
 * A singleton browser + page is kept alive across calls so that `open_url` followed
 * by `get_page_text` reads the same page (matching Safari's stateful behaviour).
 *
 * Activation: BROWSER_BACKEND=playwright (auto-set when platform is "linux").
 * Setup (one-time): npx playwright install chromium
 *
 * Security: only runs AFTER founder HITL approval in agent-tools/personal.ts.
 * The path-guard does not apply here (URLs are external), but dangerous JS is
 * flagged by flagDangerousCommand before the HITL card is shown.
 */

import type { ShellResult, BrowserAction } from "./personal.js";

const MAX_CHARS = 100_000;

// Lazily-imported to avoid loading Playwright in processes where it isn't needed.
let _browser: import("playwright").Browser | null = null;
let _page: import("playwright").Page | null = null;

async function getPage(): Promise<import("playwright").Page> {
  if (!_browser) {
    const { chromium } = await import("playwright");
    _browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",           // Required on Ubuntu VPS (no kernel user namespace)
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // Prevents /dev/shm overflow in low-memory containers
      ],
    });
  }
  if (!_page || _page.isClosed()) {
    _page = await _browser.newPage();
    // Sensible UA so sites don't serve degraded content
    await _page.setExtraHTTPHeaders({ "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 FounderOS/1.0" });
  }
  return _page;
}

export async function playwrightBrowserAction(
  action: BrowserAction,
  opts: { url?: string; js?: string },
): Promise<ShellResult> {
  try {
    const page = await getPage();

    switch (action) {
      case "open_url": {
        const url = opts.url ?? "about:blank";
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return { ok: true, stdout: `Opened ${url}`, stderr: "" };
      }
      case "get_page_text": {
        // String-based evaluate avoids DOM type errors in the Node.js tsconfig.
        const text = (await page.evaluate("document.body?.innerText ?? ''")) as string;
        return { ok: true, stdout: text.slice(0, MAX_CHARS), stderr: "" };
      }
      case "run_js": {
        const result: unknown = await page.evaluate(opts.js ?? "undefined");
        return { ok: true, stdout: String(result ?? "").slice(0, MAX_CHARS), stderr: "" };
      }
    }
  } catch (e) {
    return { ok: false, error: `Playwright browser action failed: ${(e as Error).message}` };
  }
}

/** Gracefully close the browser (call on process exit). */
export async function closeBrowser(): Promise<void> {
  if (_page && !_page.isClosed()) await _page.close().catch(() => undefined);
  if (_browser) await _browser.close().catch(() => undefined);
  _browser = null;
  _page = null;
}
