/**
 * FounderOS — Career Tools (Job-Hunt Department)
 * ================================================
 * Two read-only tools for the jobhunt department:
 *
 *   readCvTool   — queries the personal-rag API (localhost:8765) for CV/background data.
 *                  Falls back to reading wiki.md directly if the API is unavailable.
 *
 *   searchJobsTool — wraps Firecrawl web search, optimised for job postings.
 *                    Appends location to query when provided.
 *
 * Both are READ-ONLY — no HITL needed. The HITL gate fires when the agent
 * calls send_email (already gated) to submit a job application.
 *
 * ADR-015 boundary: personal-rag is READ-ONLY here. This tool NEVER writes to
 * personal-rag or turicks-brain. No auto-submit of applications — every send
 * goes through the existing HITL-gated send_email tool.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { childLogger } from "../infra/logger.js";
import { webSearchTool, type SearchResult } from "./web-search.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:career" });

// ── Config ────────────────────────────────────────────────────────────────────

const PERSONAL_RAG_URL = process.env["PERSONAL_RAG_URL"] ?? "http://localhost:8765";
const HOME_DIR = process.env["HOME"] ?? "/Users/pushkarverma";
const WIKI_FALLBACK_PATH = process.env["PERSONAL_WIKI_PATH"]
  ?? join(HOME_DIR, "Projects/personal-rag/data/wiki.md");

/**
 * The authoritative CV — a document Pushkar maintains, mirrored from Drive.
 *
 * Deliberately NOT the wiki. The wiki is synthesized from chat transcripts by a
 * local model, and on 2026-07-31 it was found to state the wrong employer name,
 * the wrong job title and dates off by a year for Contact_ME. Gap analysis that
 * reads it produces confident findings about a career that did not happen.
 */
const CV_PATH = process.env["PERSONAL_CV_PATH"]
  ?? join(HOME_DIR, "Projects/personal-rag/data/local_docs/cv-master.md");

/**
 * Root of the per-track CV workspaces: `<dir>/<track>/cv.md`.
 *
 * One CV cannot serve three tracks. The AI, backend and frontend markets ask for
 * different things, and a single document measured against all three produces a
 * gap list that is wrong for each of them — every backend term reads as a gap on
 * an AI CV and vice versa.
 *
 * The single-file path remains the fallback so nothing breaks before the three
 * documents exist.
 */
const CV_DIR = process.env["PERSONAL_CV_DIR"]
  ?? join(HOME_DIR, "Projects/personal-rag/data/local_docs/cv");

// ── read_cv ───────────────────────────────────────────────────────────────────

export const readCvTool: UnifiedTool = {
  name: "read_cv",
  description:
    "Read Pushkar Verma's CV, career background, and skills from his personal knowledge base. " +
    "Use for: understanding experience relevant to a job description, answering 'what skills do we have', " +
    "fetching salary expectations, work history, or portfolio signals. Read-only, no approval needed.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to look up. E.g. 'LangGraph experience', 'salary expectations', 'TypeScript projects', 'AI agent skills'. " +
          "Omit or use 'general overview' to get a full career summary.",
      },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const raw = (args["query"] as string | undefined) ?? "";
    const query = raw.trim().length > 0 ? raw : "general background, skills, and portfolio";

    // ── Try personal-rag REST API first ──────────────────────────────────────
    try {
      const resp = await fetch(`${PERSONAL_RAG_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, top_k: 5 }),
        signal: AbortSignal.timeout(4000),
      });

      if (resp.ok) {
        const body = (await resp.json()) as {
          query: string;
          results: Array<{ text: string; metadata: Record<string, unknown>; score: number }>;
          total: number;
        };

        if (body.results.length === 0) {
          return {
            success: true,
            data: `No specific CV entries found for "${query}". Try rephrasing the query.`,
          };
        }

        const formatted = body.results
          .map((r, i) => {
            const src = (r.metadata["source_file"] as string | undefined) ?? "wiki";
            return `${i + 1}. [${src}] ${r.text.trim()}`;
          })
          .join("\n\n");

        log.debug({ query, total: body.total }, "personal-rag API hit");
        return {
          success: true,
          data: `CV/background search for "${query}" (${body.total} results):\n\n${formatted}`,
        };
      }
    } catch {
      log.debug({ query }, "personal-rag API unavailable, falling back to wiki.md");
    }

    // ── Fallback: read wiki.md directly ──────────────────────────────────────
    try {
      const wiki = readFileSync(WIKI_FALLBACK_PATH, "utf-8");

      // Very basic keyword filter: split into sections and return matching lines
      const queryLower = query.toLowerCase();
      const lines = wiki.split("\n");
      const relevant: string[] = [];
      let inRelevantSection = false;

      for (const line of lines) {
        const lineLower = line.toLowerCase();
        if (line.startsWith("#")) {
          inRelevantSection = queryLower.split(" ").some((kw) => kw.length > 3 && lineLower.includes(kw));
        }
        if (
          inRelevantSection ||
          queryLower.split(" ").some((kw) => kw.length > 3 && lineLower.includes(kw))
        ) {
          relevant.push(line);
        }
      }

      const excerpt =
        relevant.length > 0
          ? relevant.slice(0, 60).join("\n")
          : wiki.slice(0, 2000); // fallback to first 2000 chars of wiki

      log.debug({ query, lines: relevant.length }, "wiki.md fallback used");
      return {
        success: true,
        data: `CV data (wiki fallback) for "${query}":\n\n${excerpt}`,
      };
    } catch (err) {
      const msg = (err as Error).message;
      log.error({ query, err: msg }, "Both personal-rag API and wiki.md failed");
      return {
        success: false,
        error: "CV data unavailable. Start personal-rag with: cd ~/Projects/personal-rag && uvicorn api:app --port 8765 — then try again.",
      };
    }
  },
};

// ── Full CV text (for whole-document analysis, not search) ───────────────────

/** Below this, the "CV" is a search excerpt or a stub, not a CV. */
const MIN_PLAUSIBLE_CV_CHARS = 800;

export type CvTextResult =
  | { ok: true; text: string; source: "cv"; path: string }
  | { ok: false; error: string };

/**
 * Where a track's CV lives, and where to look if it doesn't exist yet.
 *
 * The per-track file is preferred; the shared master is the fallback. There is
 * deliberately NO fallback from one track to another: a frontend gap report
 * computed against the AI CV would be confidently wrong in both directions.
 */
export function cvPathsForTrack(track?: string): string[] {
  if (!track || track === "unclassified") return [CV_PATH];
  return [join(CV_DIR, track, "cv.md"), CV_PATH];
}

/**
 * Read the WHOLE CV document.
 *
 * `readCvTool` answers a QUERY — personal-rag returns its top 5 chunks, and the
 * wiki fallback returns only lines matching the query keywords. That is right
 * for "what's my LangGraph experience" and wrong for anything that needs to know
 * what the CV does NOT say.
 *
 * Observed 2026-07-29: cv_gaps called readCvTool and got 195 characters back,
 * then reported 18 skills as "missing from your CV" — every one of which the CV
 * may well have stated. A gap report is a claim about absence, and absence can
 * only be read off the complete document.
 *
 * Read-only (ADR-015). Never writes to personal-rag.
 *
 * With a `track`, reads that track's workspace CV and falls back to the shared
 * master. It never falls back to ANOTHER track — a frontend report built on the
 * AI CV would invent gaps and hide real ones at the same time.
 */
export function readFullCvText(track?: string): CvTextResult {
  const candidates = cvPathsForTrack(track);
  const failures: string[] = [];

  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (err) {
      failures.push(`${path}: ${(err as Error).message}`);
      continue;
    }

    // A too-short file is a HARD stop, not a reason to try the next candidate.
    // Falling through would answer a question about the track's CV using the
    // master, and report the result as though it were the track's.
    if (text.trim().length < MIN_PLAUSIBLE_CV_CHARS) {
      return {
        ok: false,
        error:
          `The CV document at ${path} is only ${text.trim().length} characters. ` +
          "Refusing to compute gaps from it — a near-empty CV makes every skill in the " +
          "market look missing.",
      };
    }
    return { ok: true, text, source: "cv", path };
  }

  // No silent fall back to the wiki. The wiki is model-synthesized from chat
  // transcripts and has been observed to state the wrong employer, title and
  // dates — substituting it here would turn a missing file into a confidently
  // wrong gap report, which is the more expensive failure.
  return {
    ok: false,
    error:
      `Could not read the CV${track ? ` for the ${track} track` : ""}. Tried:\n` +
      failures.map((f) => `  · ${f}`).join("\n") +
      "\nGaps cannot be computed without it. Set PERSONAL_CV_DIR (per-track) or " +
      "PERSONAL_CV_PATH (shared), or restore the file — the synthesized wiki is NOT " +
      "an acceptable substitute.",
  };
}

// ── search_jobs ───────────────────────────────────────────────────────────────

export const searchJobsTool: UnifiedTool = {
  name: "search_jobs",
  description:
    "Search the web for job openings, hiring notices, and role descriptions. " +
    "Optimised for AI/agent engineering roles but works for any position. " +
    "Provide a role + company type query (e.g. 'LangGraph AI engineer Amsterdam'). Read-only, no approval needed.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Role and keywords, e.g. 'LangGraph senior AI engineer startup'",
      },
      location: {
        type: "string",
        description: "Optional location to append, e.g. 'Amsterdam' or 'remote EU'",
      },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = (args["query"] as string | undefined) ?? "";
    const location = args["location"] as string | undefined;
    const fullQuery = location ? `${query} ${location} jobs hiring` : `${query} jobs hiring`;

    // Delegate to search_web, which carries its own Gemini-grounding → DuckDuckGo
    // fallback chain (both free, keyless). No separate vendor SPOF here.
    const result = await webSearchTool.execute({ query: fullQuery, limit: 8 });
    if (!result.success) {
      return { success: false, error: `Job search failed: ${result.error}` };
    }

    const items = (result.data as SearchResult[]) ?? [];
    if (items.length === 0) {
      return { success: true, data: `No job listings found for "${fullQuery}". Try broader keywords.` };
    }

    const formatted = items
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet.slice(0, 300).replace(/\n+/g, " ")}`)
      .join("\n\n");

    log.info({ query: fullQuery, count: items.length }, "Job search completed");
    return {
      success: true,
      data: `Job search results for "${fullQuery}" (${items.length} found):\n\n${formatted}`,
    };
  },
};
