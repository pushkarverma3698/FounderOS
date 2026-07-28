/**
 * Job-Hunt department tools (read-only research; send_email is shared from comms).
 *   read_cv     — read CV/background from personal-rag (read-only)
 *   search_jobs — search job postings (read-only)
 *   screen_job  — apply the hard legal gates before any drafting (records a row)
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readCvTool, searchJobsTool } from "../../tools/career.js";
import { screenJobTool } from "../../tools/jobhunt/screen.js";

// ── Job-Hunt: read CV from personal-rag (read-only, NO approval) ─────────────

export const readCv = tool(
  async ({ query }) => {
    const res = await readCvTool.execute({ query });
    if (!res.success) return `CV read failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "read_cv",
    description: readCvTool.description,
    schema: z.object({
      query: z.string().describe(
        "What to look up from the CV/background. E.g. 'LangGraph experience', 'TypeScript projects', 'salary expectations'"
      ),
    }),
  },
);

// ── Job-Hunt: search for job postings (read-only, NO approval) ───────────────

export const searchJobs = tool(
  async ({ query, location }) => {
    const res = await searchJobsTool.execute({ query, ...(location ? { location } : {}) });
    if (!res.success) return `Job search failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "search_jobs",
    description: searchJobsTool.description,
    schema: z.object({
      query: z.string().describe("Role + keywords, e.g. 'AI engineer LangGraph TypeScript'"),
      location: z.string().optional().nullable().describe("Location, e.g. 'Amsterdam' or 'remote EU'"),
    }),
  },
);

// ── Job-Hunt: screen a posting against the hard gates (NO approval) ──────────
//
// Writes a screening row, but needs no HITL gate: it has no outward-facing side
// effect and its whole purpose is to run before a human looks at anything.

export const screenJob = tool(
  async ({ company, title, url, description, salary_min, salary_max }) => {
    const res = await screenJobTool.execute({
      company,
      title,
      ...(url ? { url } : {}),
      ...(description ? { description } : {}),
      ...(salary_min != null ? { salary_min } : {}),
      ...(salary_max != null ? { salary_max } : {}),
    });
    if (!res.success) return `Job screening failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "screen_job",
    description: screenJobTool.description,
    schema: z.object({
      company: z.string().describe("Employer name exactly as printed on the posting"),
      title: z.string().describe("Role title, e.g. 'Senior AI Engineer'"),
      url: z.string().optional().nullable().describe("Link to the posting"),
      description: z
        .string()
        .optional()
        .nullable()
        .describe("Posting text — used for the Dutch-language requirement check"),
      salary_min: z.number().optional().nullable().describe("Advertised annual base minimum in EUR"),
      salary_max: z.number().optional().nullable().describe("Advertised annual base maximum in EUR"),
    }),
  },
);
