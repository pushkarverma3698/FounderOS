/**
 * Engineering/QA department tool — ui_check (HITL-gated).
 * ========================================================
 * Renders pages in headless Chromium and reports what is measurably broken.
 *
 * ## Why this is gated when it only reads
 *
 * It makes the bot fetch an arbitrary URL of the model's choosing, which is the
 * same reach the `browser` tool has and the same reason that one is gated: an
 * indirect prompt injection that can pick the URL can use the VPS as a fetcher.
 * The founder approves the target before anything loads.
 *
 * CI does NOT go through this wrapper — scripts/qa-ui.ts calls runUiCheck()
 * directly, which is the existing tools/ (raw) vs agent-tools/ (gated) split. So
 * gating here costs the automated gate nothing.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { uiCheckTool } from "../../tools/browser/ui-check.js";
import type { UiCheckRow } from "../../tools/browser/ui-analyze.js";
import { hitlGate } from "./hitl.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tools:ui-qa" });

/** Founder-facing render: every reason gets its own bullet with its own result. */
function formatRows(rows: readonly UiCheckRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`${row.ok ? "✅" : "❌"} ${row.target} @ ${row.viewport} — ${row.url}`);
    if (row.defects.length === 0) {
      lines.push("   • No measurable defects: it rendered, assets loaded, nothing left unfilled.");
      continue;
    }
    for (const d of row.defects) {
      const icon = d.severity === "high" ? "🔴" : d.severity === "medium" ? "🟡" : "⚪";
      lines.push(`   ${icon} ${d.detail}`);
    }
  }
  return lines.join("\n");
}

export const uiCheck = tool(
  async ({ urls, viewports, client }, config) => {
    const targets = urls.join(", ");

    const rejected = await hitlGate(
      {
        action: "ui_check",
        title: "🖥️ Open these pages in a headless browser?",
        summary: `Render and inspect: ${targets}`,
        preview:
          "Loads each page in headless Chromium, checks for unfilled placeholders, " +
          "JavaScript errors, missing stylesheets, blank pages and sideways scrolling, " +
          "then reports what it found. No AI call, no changes to anything.",
        args: { urls, viewports, client },
      },
      config,
    );
    if (rejected) return rejected;

    const res = await uiCheckTool.execute({
      urls,
      ...(viewports && viewports.length > 0 ? { viewports } : {}),
      ...(client ? { client } : {}),
    });

    if (!res.success) {
      log.error({ urls, error: res.error }, "ui_check failed");
      return `❌ Could not check those pages: ${res.error}`;
    }

    const data = res.data as { rows: UiCheckRow[]; checked: number; high_severity: number; ok: boolean };
    const header = data.ok
      ? `✅ All ${data.checked} page/viewport combination(s) rendered cleanly.`
      : `❌ ${data.high_severity} blocking defect(s) across ${data.checked} page/viewport combination(s).`;

    return `${header}\n\n${formatRows(data.rows)}`;
  },
  {
    name: "ui_check",
    description:
      "Render web pages in a headless browser and report what is visibly broken — unfilled template " +
      "placeholders, JavaScript errors, missing stylesheets or images, blank pages, sideways scrolling, " +
      "invisible sections. Use when asked to check, verify, or debug how a page or site actually looks. " +
      "Deterministic and free; the founder is asked to APPROVE before any page is loaded.",
    schema: z.object({
      urls: z.array(z.string()).describe("Page URLs or local file paths to render and check."),
      viewports: z
        .array(z.enum(["desktop", "mobile"]))
        .optional()
        .nullable()
        .describe("Which viewports to check. Defaults to both."),
      client: z
        .string()
        .optional()
        .nullable()
        .describe("Client name substituted for {{CLIENT}} before rendering, matching apply_cinematic_preset."),
    }),
  },
);
