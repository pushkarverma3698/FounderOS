/**
 * AI Visibility Gap Scanner — research department wrapper.
 * Read-only detection (lead-acquisition spec Layer 1): NO HITL gate
 * (rule #13 — gates guard external SENDS, not reads). The Markdown 1-pager
 * is the deliverable; the founder sends it manually after a prospect replies
 * (permission-first artifact — nothing is ever sent by this tool).
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { gapScannerTool } from "../../tools/gap-scanner.js";

export const scanAiVisibility = tool(
  async ({ company_name, domain, category, competitors, runs_per_prompt }) => {
    const res = await gapScannerTool.execute({
      company_name,
      domain,
      category,
      competitors,
      ...(typeof runs_per_prompt === "number" ? { runs_per_prompt } : {}),
    });
    if (!res.success) {
      return `AI visibility scan failed: ${res.error ?? "unknown error"}`;
    }
    const { gap_score, markdown } = res.data as { gap_score: number; markdown: string };
    return `Gap Score ${gap_score}/100 for ${company_name} (${domain}).\n\n${markdown}`;
  },
  {
    name: "scan_ai_visibility",
    description:
      "Detect a company's AI-visibility gap: sample buyer-intent prompts across AI answer surfaces (ChatGPT-class, " +
      "Perplexity-class, Google AI) N times each and report appearance rates vs named competitors, a 0-100 Gap Score, " +
      "diagnosed causes, and a 1-page Markdown gap report ready to send a prospect. " +
      "Slow (many model calls) — use for deliberate prospect/self scans, not casual questions. Read-only — no approval needed.",
    schema: z.object({
      company_name: z.string().describe("Target company name, e.g. 'Acme'"),
      domain: z.string().describe("Target company domain, e.g. 'acme.com'"),
      category: z.string().describe("Product category buyers would ask about, e.g. 'CRM for SMBs'"),
      competitors: z
        .string()
        .describe("1-5 competitors as comma-separated Name=domain pairs, e.g. 'HubSpot=hubspot.com, Close=close.com'"),
      runs_per_prompt: z.number().optional().nullable().describe("Samples per prompt per surface (1-5, default 3)"),
    }),
  },
);
