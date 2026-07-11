/**
 * AI Visibility Gap Scanner — research department wrappers.
 * Read-only detection (lead-acquisition spec Layer 1): NO HITL gate
 * (rule #13 — gates guard external SENDS, not reads). The Markdown 1-pager
 * is the deliverable; the founder sends it manually after a prospect replies
 * (permission-first artifact — nothing is ever sent by these tools).
 *
 * scan_ai_visibility runs a NEW scan (slow, paid surface calls) and persists
 * it to gap_scans; get_gap_scans retrieves PAST scans from the DB at $0 —
 * agents must prefer retrieval when the founder asks about an existing scan.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { gapScannerTool } from "../../tools/gap-scanner.js";
import { normalizeDomain } from "../../tools/gap-scan-core.js";
import { getLatestGapScan, listGapScans, getGapScanById } from "../../db/gap-scan-queries.js";

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
    const { gap_score, markdown, persisted, scan_id, persist_error } = res.data as {
      gap_score: number;
      markdown: string;
      persisted?: boolean;
      scan_id?: string;
      persist_error?: string;
    };
    const saved = persisted
      ? `Saved to gap_scans (${scan_id}) — retrievable later via get_gap_scans.`
      : `NOT saved to gap_scans: ${persist_error ?? "unknown"}.`;
    return `Gap Score ${gap_score}/100 for ${company_name} (${domain}). ${saved}\n\n${markdown}`;
  },
  {
    name: "scan_ai_visibility",
    description:
      "Run a NEW AI-visibility gap scan: sample buyer-intent prompts across AI answer surfaces (ChatGPT-class, " +
      "Perplexity-class, Google AI) N times each and report appearance rates vs named competitors, a 0-100 Gap Score, " +
      "multi-angle insights (intent funnel, threat profile, consistency, confidence), and a 1-page Markdown gap report. " +
      "Slow (many model calls) — use for deliberate prospect/self scans, not casual questions. The result is saved to " +
      "the gap_scans table; use get_gap_scans first if a recent scan may already exist. Read-only — no approval needed.",
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

function summaryLine(s: {
  target_name: string;
  target_domain: string;
  category: string;
  gap_score: number;
  confidence: string;
  created_at: Date | null;
}): string {
  const when = s.created_at ? s.created_at.toISOString().slice(0, 10) : "unknown date";
  return `- ${when} · ${s.target_name} (${s.target_domain}) · ${s.category} · Gap Score ${s.gap_score}/100 · confidence ${s.confidence}`;
}

export const getGapScans = tool(
  async ({ domain, category, limit, full_report, scan_id }) => {
    // Direct id lookup (e.g. from a summary list line) returns that exact report.
    if (scan_id) {
      const scan = await getGapScanById(scan_id);
      if (!scan) return `No gap scan found with id ${scan_id}. List scans first (no scan_id) to see valid ids.`;
      const when = scan.created_at ? scan.created_at.toISOString().slice(0, 10) : "unknown date";
      return `Gap scan ${scan.id} — ${scan.target_name} (${scan.target_domain}), ${when}:\n\n${scan.markdown}`;
    }

    const normalized = domain ? normalizeDomain(domain) : undefined;

    if (full_report && normalized) {
      const scan = await getLatestGapScan(normalized);
      if (!scan) return `No saved gap scan found for ${normalized}. Run scan_ai_visibility to create one.`;
      const when = scan.created_at ? scan.created_at.toISOString().slice(0, 10) : "unknown date";
      return `Latest saved scan for ${normalized} (${when}, id ${scan.id}):\n\n${scan.markdown}`;
    }

    const scans = await listGapScans({
      ...(normalized ? { domain: normalized } : {}),
      ...(category ? { category } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    });
    if (scans.length === 0) {
      const scope = normalized ?? category ?? "any company";
      return `No saved gap scans found for ${scope}. Run scan_ai_visibility to create one.`;
    }
    return `Saved gap scans (newest first):\n${scans.map(summaryLine).join("\n")}\n\nUse full_report=true with a domain to retrieve a full report.`;
  },
  {
    name: "get_gap_scans",
    description:
      "Retrieve PAST AI-visibility gap scans from the gap_scans table ($0, instant — no model calls). " +
      "List scan history filtered by target domain (trend over time) or category (the vertical dataset), " +
      "fetch the latest full 1-page report for a domain with full_report=true, or fetch one exact scan by scan_id. " +
      "Always try this BEFORE scan_ai_visibility when the founder asks about an existing/previous scan.",
    schema: z.object({
      domain: z.string().optional().nullable().describe("Filter by target domain, e.g. 'acme.com'"),
      category: z.string().optional().nullable().describe("Filter by exact category, e.g. 'CRM for SMBs'"),
      limit: z.number().optional().nullable().describe("Max rows (default 10, max 50)"),
      full_report: z
        .boolean()
        .optional()
        .nullable()
        .describe("With domain: return the latest full Markdown report instead of a summary list"),
      scan_id: z
        .string()
        .optional()
        .nullable()
        .describe("Fetch one exact scan by its id (from a summary list line) — returns that full report"),
    }),
  },
);
