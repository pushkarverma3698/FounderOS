/**
 * FounderOS — Playwright Browser Backend
 * ========================================
 * Drop-in replacement for the AppleScript/Safari browser backend on Linux/Ubuntu VPS.
 * Uses headless Chromium via the Playwright API — no display server required.
 *
 * A singleton browser + page is kept alive across calls so that `open_url` followed
 * by `get_page_text` reads the same page (matching Safari's stateful behaviour).
 * That lifecycle now lives in ./browser/chromium.ts so the UI-QA checker shares
 * ONE Chromium process with this tool instead of launching a second one. This
 * module's exported surface is unchanged.
 *
 * Activation: BROWSER_BACKEND=playwright (auto-set when platform is "linux").
 * Setup (one-time): npx playwright install chromium
 *
 * Security: only runs AFTER founder HITL approval in agent-tools/personal.ts.
 * The path-guard does not apply here (URLs are external), but dangerous JS is
 * flagged by flagDangerousCommand before the HITL card is shown.
 */

import type { ShellResult, BrowserAction } from "./personal.js";
import { getPage, closeBrowser as closeSharedBrowser, MAX_CHARS } from "./browser/chromium.js";

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
  await closeSharedBrowser();
}
