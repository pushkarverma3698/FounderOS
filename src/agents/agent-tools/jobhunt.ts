/**
 * Job-Hunt department tools (read-only research; send_email is shared from comms).
 *   read_cv     — read CV/background from personal-rag (read-only)
 *   search_jobs — search job postings (read-only)
 *   ingest_jobs — pull postings from the ATS feed and screen them all (supply)
 *   screen_job  — apply the hard legal gates before any drafting (records a row)
 *   review_screened — audit what the gates decided (the only view of silent rejects)
 *   cv_gaps     — what the screened market asks for vs. what the CV says
 *   job_brief   — the ranked shortlist: what to apply to today, verified still open
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readCvTool, searchJobsTool } from "../../tools/career.js";
import { screenJobTool } from "../../tools/jobhunt/screen.js";
import { reviewScreenedTool } from "../../tools/jobhunt/review.js";
import { ingestJobsTool } from "../../tools/jobhunt/ingest-tool.js";
import { cvGapsTool } from "../../tools/jobhunt/gaps.js";
import { jobBriefTool } from "../../tools/jobhunt/daily-brief.js";

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

// ── Job-Hunt: pull postings from the ATS feed and screen them (NO approval) ──
//
// Writes screening rows, but has no outward-facing side effect: nothing is sent,
// nothing is applied to. The HITL gate stays where it belongs, on send_email.

export const ingestJobs = tool(
  async ({ limit, time_range, titles, locations, organizations }) => {
    const res = await ingestJobsTool.execute({
      ...(limit != null ? { limit } : {}),
      ...(time_range ? { time_range } : {}),
      ...(titles ? { titles } : {}),
      ...(locations ? { locations } : {}),
      ...(organizations ? { organizations } : {}),
    });
    if (!res.success) return `Job ingest failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "ingest_jobs",
    description: ingestJobsTool.description,
    schema: z.object({
      limit: z.number().optional().nullable().describe("Postings to pull (minimum 10)"),
      time_range: z
        .enum(["1h", "24h", "7d", "6m"])
        .optional()
        .nullable()
        .describe("How far back to look. Defaults to 24h"),
      titles: z
        .array(z.string())
        .optional()
        .nullable()
        .describe("Title phrases, ':*' is a prefix wildcard, e.g. ['AI Engineer:*']"),
      locations: z
        .array(z.string())
        .optional()
        .nullable()
        .describe("English 'City, Region, Country' phrases or a bare country"),
      organizations: z
        .array(z.string())
        .optional()
        .nullable()
        .describe("Restrict to named employers, e.g. recognised sponsors to target"),
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

// ── Job-Hunt: CV vs. the screened market (read-only, suggests only) ──────────

export const cvGaps = tool(
  async ({ category, track }) => {
    const res = await cvGapsTool.execute({
      ...(category ? { category } : {}),
      ...(track ? { track } : {}),
    });
    if (!res.success) return `CV gap report failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "cv_gaps",
    description: cvGapsTool.description,
    schema: z.object({
      category: z
        .enum(["language", "framework", "infra", "data", "ai", "practice"])
        .optional()
        .nullable()
        .describe("Narrow the report to one category"),
      track: z
        .enum(["ai", "backend", "frontend"])
        .optional()
        .nullable()
        .describe("Which career track's CV and market to compare. Defaults to ai"),
    }),
  },
);

// ── Job-Hunt: the ranked brief — what to apply to today (read-only) ──────────

export const jobBrief = tool(
  async ({ skip_liveness }) => {
    const res = await jobBriefTool.execute({
      ...(skip_liveness != null ? { skip_liveness } : {}),
    });
    if (!res.success) return `Job brief failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "job_brief",
    description: jobBriefTool.description,
    schema: z.object({
      skip_liveness: z
        .boolean()
        .optional()
        .nullable()
        .describe("Skip the still-open check — faster, but rows read 'couldn't confirm'"),
    }),
  },
);
