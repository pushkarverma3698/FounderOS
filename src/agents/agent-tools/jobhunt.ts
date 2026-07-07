/**
 * Job-Hunt department tools (read-only research; send_email is shared from comms).
 *   read_cv     — read CV/background from personal-rag (read-only)
 *   search_jobs — search job postings (read-only)
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readCvTool, searchJobsTool } from "../../tools/career.js";

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
