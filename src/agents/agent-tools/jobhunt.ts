/**
 * Job-Hunt department tools (read-only research; send_email is shared from comms).
 *   read_cv     — read CV/background from personal-rag (read-only)
 *   search_jobs — search job postings (read-only)
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readCvTool, searchJobsTool } from "../../tools/career.js";
import { makeRepeatGuard, repeatGuardBlockMessage } from "./repeat-guard.js";

// Loop breakers (T04, extended): bound identical read_cv / search_jobs calls.
const _readCvRepeatGuard = makeRepeatGuard();
const _searchJobsRepeatGuard = makeRepeatGuard();

// ── Job-Hunt: read CV from personal-rag (read-only, NO approval) ─────────────

export const readCv = tool(
  async ({ query }) => {
    if (_readCvRepeatGuard.shouldBlock("read_cv", { query })) {
      return repeatGuardBlockMessage("read_cv", "CV/background data");
    }
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
    if (_searchJobsRepeatGuard.shouldBlock("search_jobs", { query, location })) {
      return repeatGuardBlockMessage("search_jobs", "job search results");
    }
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
