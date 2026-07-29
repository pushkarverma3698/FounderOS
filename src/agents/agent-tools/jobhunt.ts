/**
 * Job-Hunt department tools (read-only research; send_email is shared from comms).
 *   read_cv     — read CV/background from personal-rag (read-only)
 *   search_jobs — search job postings (read-only)
 *   screen_job  — apply the hard legal gates before any drafting (records a row)
 *   review_screened — audit what the gates decided (the only view of silent rejects)
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readCvTool, searchJobsTool } from "../../tools/career.js";
import { screenJobTool } from "../../tools/jobhunt/screen.js";
import { reviewScreenedTool } from "../../tools/jobhunt/review.js";

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
  async ({ company, title, url, description }) => {
    const res = await screenJobTool.execute({
      company,
      title,
      description,
      ...(url ? { url } : {}),
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
      // No salary fields by design: the figures are parsed from this text in code.
      // Dutch writes "€4.500" for 4500, and a model reading that dot as a decimal
      // point would reject the entire market as below the permit floor.
      description: z
        .string()
        .describe(
          "The posting text, VERBATIM and unsummarised. Salary, hours, language requirement " +
            "and remote/on-site status are parsed from it in code — do not paraphrase or " +
            "convert any figures yourself.",
        ),
    }),
  },
);

// ── Job-Hunt: audit what the gates have been deciding (read-only) ────────────

export const reviewScreened = tool(
  async ({ verdict, route, limit }) => {
    const res = await reviewScreenedTool.execute({
      ...(verdict ? { verdict } : {}),
      ...(route ? { route } : {}),
      ...(limit != null ? { limit } : {}),
    });
    if (!res.success) return `Screening review failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "review_screened",
    description: reviewScreenedTool.description,
    schema: z.object({
      verdict: z.enum(["pass", "flag", "reject"]).optional().nullable().describe("Filter to one outcome"),
      route: z.enum(["hsm", "remote-contract"]).optional().nullable().describe("Filter to one route"),
      limit: z.number().optional().nullable().describe("Rows to show (default 25, max 100)"),
    }),
  },
);
