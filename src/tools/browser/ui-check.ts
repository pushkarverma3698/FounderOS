/**
 * FounderOS — ui_check: deterministic, $0 rendered-page verification
 * ===================================================================
 * Renders a page in headless Chromium and reports what is measurably wrong with
 * it. NO model call happens here — every finding is a measurement, so this runs
 * free in CI and its output is reproducible. Vision (./ui-vision.ts) is a
 * separate, opt-in stage for the judgements measurement cannot make.
 *
 * ## Why this exists
 *
 * Client-facing Proof Drop showcases are built by an LLM from the scaffolds in
 * assets/cinematic-presets/ and published by deploy_static_site, which copies
 * files and returns a URL. Nothing in that pipeline ever looks at the page, so a
 * broken stylesheet, a blank hero, or a literal `{{TAGLINE}}` reaches a prospect
 * with nothing in between.
 *
 * apply_cinematic_preset substitutes ONLY `{{CLIENT}}`
 * (src/tools/cinematic-preset.ts:98) — so any other placeholder a preset gains
 * ships verbatim. That is why `unsubstituted-placeholder` is HIGH and why
 * callers declare the substitutions they expect to have been applied.
 *
 * ## Structure
 *
 *   ./ui-facts.ts    — I/O: drives the browser, gathers raw measurements
 *   ./ui-analyze.ts  — PURE: facts → defects, fixture-tested without Chromium
 *   this file        — orchestration + the UnifiedTool surface
 *
 * ## This module imports no config, deliberately
 *
 * Nothing here reaches src/core/config.ts, so `pnpm qa:ui` runs in CI with NO
 * secrets — no DATABASE_URL, no Telegram token. A gate that renders static HTML
 * must not need a database to do it, and one that demands production secrets to
 * start is a gate that gets switched off. That is also why a render failure is
 * returned as a defect rather than logged: the message lands in the row either
 * way, and the logger is what pulls config in.
 */

import { collectPageFacts, capturePng, type UiTarget } from "./ui-facts.js";
import { analyzePageFacts, rowIsOk, type UiCheckRow } from "./ui-analyze.js";
import type { ViewportName } from "./chromium.js";
import type { ToolResult, UnifiedTool } from "../index.js";

export const DEFAULT_VIEWPORTS: ViewportName[] = ["desktop", "mobile"];

export interface UiCheckOptions {
  targets: readonly UiTarget[];
  viewports?: readonly ViewportName[];
  substitutions?: Record<string, string>;
  /** Directory to write PNGs into. Omitted = facts only, no screenshots. */
  screenshotDir?: string;
}

/**
 * Check every target at every viewport.
 *
 * Never throws. A target that fails to render becomes a `render-failed` HIGH row
 * rather than an exception, because a crash that produces no row is
 * indistinguishable from a clean pass — the same did-not-run-reads-as-clean
 * failure src/evolution/run-audit.ts exists to prevent.
 */
export async function runUiCheck(opts: UiCheckOptions): Promise<UiCheckRow[]> {
  const viewports = opts.viewports?.length ? opts.viewports : DEFAULT_VIEWPORTS;
  const substitutions = opts.substitutions ?? {};
  const rows: UiCheckRow[] = [];

  for (const target of opts.targets) {
    for (const viewport of viewports) {
      try {
        const facts = await collectPageFacts(target, viewport, substitutions);
        const defects = analyzePageFacts(facts);
        const shot = opts.screenshotDir
          ? await capturePng(target, viewport, substitutions, opts.screenshotDir)
          : undefined;
        rows.push({
          target: target.id,
          url: target.url,
          viewport,
          ok: rowIsOk(defects),
          defects,
          ...(shot ? { screenshotPath: shot } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        rows.push({
          target: target.id,
          url: target.url,
          viewport,
          ok: false,
          defects: [{
            kind: "render-failed",
            severity: "high",
            detail: `The page could not be rendered at all in a headless browser: ${message}`,
          }],
        });
      }
    }
  }
  return rows;
}

/** How many high-severity defects a set of rows carries. Exported for the CLI's exit code. */
export function highSeverityCount(rows: readonly UiCheckRow[]): number {
  return rows.flatMap((r) => r.defects).filter((d) => d.severity === "high").length;
}

export const uiCheckTool: UnifiedTool = {
  name: "ui_check",
  description:
    "Render one or more web pages in a headless browser and report what is measurably broken: " +
    "unfilled template placeholders, JavaScript errors, missing stylesheets or images, blank pages, " +
    "sideways scrolling, and invisible sections. Deterministic and free — it makes no AI call. " +
    "Use it to verify a landing page or client showcase actually renders before anyone sees it.",
  input_schema: {
    type: "object",
    properties: {
      urls: { type: "array", description: "Page URLs or local file paths to check." },
      viewports: {
        type: "array",
        description: "Which viewports to check: 'desktop', 'mobile', or both. Defaults to both.",
      },
      client: {
        type: "string",
        description: "Client name substituted for {{CLIENT}} before rendering, matching apply_cinematic_preset.",
      },
    },
    required: ["urls"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const raw = args["urls"];
    const urls = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string") : [];
    if (urls.length === 0) {
      return { success: false, error: "ui_check needs at least one URL or file path in `urls`." };
    }

    const viewportArg = args["viewports"];
    const viewports = Array.isArray(viewportArg)
      ? viewportArg.filter((v): v is ViewportName => v === "desktop" || v === "mobile")
      : [];

    const client = typeof args["client"] === "string" ? args["client"] : undefined;

    try {
      const rows = await runUiCheck({
        targets: urls.map((url, i) => ({ id: `target-${i + 1}`, url })),
        ...(viewports.length > 0 ? { viewports } : {}),
        ...(client ? { substitutions: { CLIENT: client } } : {}),
      });
      const high = highSeverityCount(rows);
      return {
        success: true,
        data: { rows, checked: rows.length, high_severity: high, ok: high === 0 },
        observed: {
          kind: "http",
          evidence: `Rendered ${rows.length} page/viewport combination(s); ${high} high-severity defect(s).`,
        },
      };
    } catch (err) {
      return { success: false, error: `ui_check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
