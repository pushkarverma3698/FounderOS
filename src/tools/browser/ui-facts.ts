/**
 * FounderOS — ui_check: the I/O half (drive the browser, gather measurements)
 * ============================================================================
 * Everything here touches the world. The judgement over what it gathers lives in
 * ./ui-analyze.ts as a pure function, so the decision logic is testable without
 * Chromium and this file stays a thin, boring collector.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { serveDirectory } from "./static-server.js";
import type { Page } from "playwright";
import { withFreshPage, screenshot, VIEWPORTS, type ViewportName } from "./chromium.js";
import type { PageFacts } from "./ui-analyze.js";

/** Browser-side probe. String-evaluated so the Node tsconfig needs no DOM types. */
const PROBE = `(() => {
  const empty = [];
  for (const tag of ['header','main','section','footer','nav','article']) {
    for (const el of document.querySelectorAll(tag)) {
      const r = el.getBoundingClientRect();
      if (r.height === 0 && (el.textContent || '').trim() === '') empty.push(tag);
    }
  }
  const broken = [];
  for (const img of document.querySelectorAll('img')) {
    if (img.complete && img.naturalWidth === 0) broken.push(img.getAttribute('src') || '(inline)');
  }
  return {
    title: document.title || '',
    bodyText: (document.body && document.body.innerText) || '',
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    emptyBlocks: empty,
    brokenImages: broken,
    headingCount: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    h1Count: document.querySelectorAll('h1').length,
  };
})()`;

type ProbeResult = {
  title: string;
  bodyText: string;
  scrollWidth: number;
  clientWidth: number;
  emptyBlocks: string[];
  brokenImages: string[];
  headingCount: number;
  h1Count: number;
};

export interface UiTarget {
  readonly id: string;
  readonly url: string;
}

/**
 * Navigate to a target, serving local files over loopback HTTP so relative
 * assets resolve and `{{PLACEHOLDER}}` substitutions are applied.
 *
 * Returns a dispose callback the caller MUST await in a `finally` — it shuts the
 * throwaway server down. Remote URLs are fetched as-is and dispose is a no-op:
 * substituting someone else's served HTML would be checking a page that does
 * not exist. See ./static-server.ts for why file:// was abandoned.
 */
export async function navigate(
  page: Page,
  url: string,
  substitutions: Record<string, string>,
): Promise<() => Promise<void>> {
  if (/^https?:\/\//i.test(url)) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return async () => undefined;
  }

  const filePath = resolve(url);
  const server = await serveDirectory(dirname(filePath), substitutions);
  try {
    await page.goto(`${server.origin}/${basename(filePath)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch (err) {
    await server.close();
    throw err;
  }
  return () => server.close();
}

/** Wait for the network to settle, but never let a chatty page fail the run. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined); // allow-failopen: a page that never idles is still worth measuring
}

/** Render one target at one viewport and collect raw facts. */
export async function collectPageFacts(
  target: UiTarget,
  viewport: ViewportName,
  substitutions: Record<string, string> = {},
): Promise<PageFacts> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedAssets: { url: string; reason: string }[] = [];

  return withFreshPage(
    async (page: Page) => {
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
      });
      page.on("pageerror", (err) => pageErrors.push(err.message.slice(0, 300)));
      page.on("requestfailed", (req) => {
        failedAssets.push({ url: req.url(), reason: req.failure()?.errorText ?? "request failed" });
      });
      page.on("response", (res) => {
        if (res.status() >= 400) failedAssets.push({ url: res.url(), reason: `HTTP ${res.status()}` });
      });

      const dispose = await navigate(page, target.url, substitutions);
      try {
        await settle(page);
        const probe = (await page.evaluate(PROBE)) as ProbeResult;

        return {
          target: target.id,
          url: target.url,
          viewport,
          ...probe,
          consoleErrors,
          pageErrors,
          failedAssets,
        };
      } finally {
        await dispose();
      }
    },
    { viewport: VIEWPORTS[viewport] },
  );
}

/** Screenshot one target at one viewport into `dir`. Returns the written path. */
export async function capturePng(
  target: UiTarget,
  viewport: ViewportName,
  substitutions: Record<string, string>,
  dir: string,
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${target.id}-${viewport}.png`);
  const bytes = await withFreshPage(
    async (page) => {
      const dispose = await navigate(page, target.url, substitutions);
      try {
        await settle(page);
        return await screenshot(page);
      } finally {
        await dispose();
      }
    },
    { viewport: VIEWPORTS[viewport] },
  );
  writeFileSync(path, bytes);
  return path;
}
