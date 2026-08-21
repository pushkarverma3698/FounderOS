/**
 * Unit tests — read_cv must reach the CV that is actually on the box.
 *
 * WHAT HAPPENED. On 2026-08-21 the founder asked, in natural language, for an
 * application to be drafted. Prod logged:
 *
 *   tool:career  ENOENT: no such file or directory,
 *                open '/home/founderos/Projects/personal-rag/data/wiki.md'
 *   → "CV data unavailable. Start personal-rag with: cd ~/Projects/personal-rag
 *      && uvicorn api:app --port 8765 — then try again."
 *
 * That instruction is addressed to a laptop. On the production VPS there is no
 * `~/Projects/personal-rag`, there never will be, and the error tells the
 * founder to fix a machine he is not sitting at. Meanwhile four complete,
 * per-track CVs sat at `/opt/founderos-data/cv/{ai,backend,frontend,fullstack}/
 * cv.md` with `PERSONAL_CV_DIR` correctly set — the data was present the whole
 * time and the tool had no path to it.
 *
 * ORDERING IS A CORRECTNESS FIX, NOT ONLY AN AVAILABILITY ONE. career.ts's own
 * docstring records that the wiki is synthesized from chat transcripts by a
 * local model and that on 2026-07-31 it stated the wrong employer, the wrong
 * title and dates off by a year. The CV is a document the founder maintains.
 * When both are readable the CV wins, because the output of this tool becomes
 * claims in a real job application.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadFileSync = vi.fn();

vi.mock("node:fs", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, readFileSync: mockReadFileSync };
});

const { readCvTool } = await import("../../../src/tools/career.js");

/**
 * Long enough to clear MIN_PLAUSIBLE_CV_CHARS (800).
 *
 * That floor is not incidental to this test: `readFullCvText` treats a short
 * file as a HARD stop rather than a reason to try the next candidate, because a
 * near-empty CV makes every skill in the market look like a gap. A fixture under
 * the floor would exercise the refusal path while appearing to test the read.
 */
const CV_CONTENT = [
  "# Pushkar Verma",
  "Senior Software Engineer · TypeScript, Python, Go · Amsterdam / Bangalore",
  "",
  "## Experience",
  "### Turicks — Founding Engineer (2024–present)",
  "- Built a deterministic LangGraph agent kernel serving production Telegram traffic,",
  "  with contract-validated boundaries and zero-hallucination action receipts.",
  "- Shipped a Postgres-backed job pipeline polling 623 ATS boards every 30 minutes,",
  "  screening roughly 31,000 live postings per sweep at no marginal cost.",
  "- Cut third-party rate-limit failures from 36 per sweep to 7 with jittered retries.",
  "",
  "### Contact_ME — Backend Engineer (2022–2024)",
  "- Owned the ingestion service handling several million events per day on Postgres.",
  "- Migrated a monolithic scheduler to a queue-backed worker pool, halving p95 latency.",
  "",
  "## Skills",
  "- Languages: TypeScript, Python, Go, SQL",
  "- Infrastructure: Postgres, Docker, systemd, GitHub Actions, Terraform",
  "- AI: LangGraph, LangChain, retrieval-augmented generation, evaluation harnesses",
  "",
  "## Education",
  "- B.Tech, Computer Science",
].join("\n");

function apiDown(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8765")),
  );
}

describe("read_cv — falls back to the CV on disk, not just the wiki", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiDown();
  });

  it("succeeds when the wiki is missing but a CV file is readable", async () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).includes("wiki")) {
        throw new Error("ENOENT: no such file or directory, open 'wiki.md'");
      }
      return CV_CONTENT;
    });

    const result = await readCvTool.execute({ query: "TypeScript experience" });

    expect(result.success).toBe(true);
    expect(String(result.data)).toContain("TypeScript");
  });

  it("prefers the maintained CV over the synthesized wiki when both are readable", async () => {
    // The wiki has been measured wrong about employer, title and dates. If both
    // sources answer, the one the founder maintains is the one that ships.
    mockReadFileSync.mockImplementation((path: string) =>
      String(path).includes("wiki") ? "# Wrong Employer\nWorked at NotARealCompany." : CV_CONTENT,
    );

    const result = await readCvTool.execute({ query: "experience" });

    expect(result.success).toBe(true);
    expect(String(result.data)).toContain("Turicks");
    expect(String(result.data)).not.toContain("NotARealCompany");
  });

  it("still answers from the wiki when no CV file exists at all", async () => {
    // The laptop case, where the wiki is the only local source. Preferring the
    // CV must not mean losing the fallback that already worked.
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).includes("wiki")) return "# LangGraph\nBuilt LangGraph pipelines in anger.";
      throw new Error("ENOENT: no such file or directory");
    });

    const result = await readCvTool.execute({ query: "LangGraph pipelines" });

    expect(result.success).toBe(true);
    expect(String(result.data)).toContain("LangGraph");
  });

  it("fails loudly, without telling a VPS to start a laptop service", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const result = await readCvTool.execute({ query: "anything" });

    expect(result.success).toBe(false);
    // The old message named `cd ~/Projects/personal-rag && uvicorn …`, which is
    // not an action available on the machine that emitted it.
    expect(String(result.error)).not.toMatch(/uvicorn/i);
    expect(String(result.error)).toMatch(/PERSONAL_CV_DIR|CV/);
  });
});
