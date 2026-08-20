/**
 * Unit tests — /draft and /ask.
 *
 * These close the loop the brief opens. Before them, every row ended in
 * "→ /draft 1" and the gateway dropped it: `if (text.startsWith("/")) return;`
 * meant the founder tapped the one control offered and got silence.
 *
 * The rule under test everywhere here is REFUSE RATHER THAN GUESS. A wrong
 * resolution does not fail visibly — it produces a polished application about a
 * company the founder never chose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  parseRowArg,
  unresolvedMessage,
  draftInstruction,
  askInstruction,
} from "../../../src/gateway/jobhunt-commands.js";
import { unknownCommandReply } from "../../../src/gateway/commands.js";
import { threadIdFor } from "../../../src/gateway/kernel-run.js";
import { ARTIFACT_ROOT } from "../../../src/core/config.js";
import type { JobApplication } from "../../../src/db/schema.js";

const ROW = {
  id: "row-1",
  company: "Aquablu B.V",
  title: "Embedded Software Engineer",
  route: "partner-permit",
  url: "https://example.com/job/1",
  salary_evidence: "Partner permit: free access to the labour market.",
  description: "We use C++ and embedded Linux. ".repeat(40),
} as unknown as JobApplication;

describe("parseRowArg", () => {
  it("reads a plain row number", () => {
    expect(parseRowArg("1")).toBe(1);
    expect(parseRowArg("  3 ")).toBe(3);
  });

  it("refuses anything that is not a plain positive integer", () => {
    // Each of these is a guess waiting to happen, and the cost of guessing is a
    // tailored application about the wrong company.
    for (const bad of ["", "two", "2nd", "-1", "0", "1.5", "1 2", "٢"]) {
      expect(parseRowArg(bad)).toBeNull();
    }
  });
});

describe("unresolvedMessage", () => {
  it("explains the usage when no number was given", () => {
    expect(unresolvedMessage("draft", null)).toContain("Usage: /draft <number>");
  });

  it("says which section the number was looked up in", () => {
    expect(unresolvedMessage("draft", 4)).toContain("DO TODAY");
    expect(unresolvedMessage("ask", 4)).toContain("ONE QUESTION AWAY");
  });

  it("says the numbers come from the latest brief only", () => {
    // Otherwise "no row 4" reads as "that job is gone" rather than "your list
    // is from an older brief".
    expect(unresolvedMessage("ask", 4)).toContain("most recent brief");
  });

  it("names the stretch section too, because /draft now spans both", () => {
    // `/draft` resolves against DO TODAY followed by the stretch section on one
    // continuous numbering (2026-08-06). Naming only the first would tell the
    // founder his row is not in a section it was never in.
    expect(unresolvedMessage("draft", 4)).toContain("STRETCH");
  });
});

describe("draftInstruction", () => {
  it("carries the posting body, not just the title", () => {
    const out = draftInstruction(ROW);
    expect(out).toContain("Aquablu B.V");
    expect(out).toContain("Embedded Software Engineer");
    expect(out).toContain("embedded Linux");
  });

  it("orders read_cv first and forbids sending", () => {
    const out = draftInstruction(ROW);
    expect(out).toContain("read_cv");
    expect(out).toMatch(/Do NOT send/i);
  });

  it("survives a row with no description or url", () => {
    const bare = { ...ROW, description: null, url: null } as unknown as JobApplication;
    expect(() => draftInstruction(bare)).not.toThrow();
    expect(draftInstruction(bare)).not.toContain("URL:");
  });
});

describe("askInstruction", () => {
  it("targets the unresolved gate rather than the role in general", () => {
    const out = askInstruction(ROW);
    expect(out).toContain("Partner permit: free access");
    expect(out).toMatch(/do not ask about the role in general/i);
    expect(out).toMatch(/Do NOT send/i);
  });

  it("sends ONLY the unresolved check to the model, never the passing ones", () => {
    // The 2026-08-01 defect. This pasted every gate — passing ones included —
    // under the heading "What is unresolved", so the model wrote a generic
    // question. The founder gets one message to an employer; spending it on a
    // check that already passed wastes it.
    const row = {
      ...ROW,
      gate_json: JSON.stringify([
        { gate: "Sponsor", status: "pass", evidence: "Exact register match." },
        { gate: "Salary", status: "flag", evidence: "No salary stated in the ad." },
        { gate: "Language", status: "pass", evidence: "No Dutch requirement found." },
      ]),
    } as unknown as JobApplication;

    const out = askInstruction(row);
    const unresolved = out.slice(out.indexOf("UNRESOLVED"), out.indexOf("ALREADY SETTLED"));

    expect(unresolved).toContain("No salary stated");
    expect(unresolved).not.toContain("Exact register match");
    expect(unresolved).not.toContain("No Dutch requirement");
    // The passing checks are still supplied — as context, clearly fenced off.
    expect(out).toMatch(/ALREADY SETTLED[\s\S]*Exact register match/);
    expect(out).toMatch(/do NOT ask about these/i);
  });

  it("admits it cannot tell which check passed on a pre-gate_json row", () => {
    // Every production row on 2026-08-01 predates the column, so every check on
    // them reads as unresolved. Handing the model three checks and calling all
    // three open — without saying we don't actually know — would reproduce the
    // exact defect this change closes, one layer down.
    const out = askInstruction(ROW);
    expect(out).toContain("Partner permit");
    expect(out).toContain("cannot tell which of these");
    expect(out).not.toContain("ALREADY SETTLED");
  });
});

describe("unknownCommandReply", () => {
  it("names the command that did not exist", () => {
    expect(unknownCommandReply("/draaft 1")).toContain("/draaft");
  });

  it("points at a way forward instead of just refusing", () => {
    const out = unknownCommandReply("/nope");
    expect(out).toContain("/commands");
    expect(out).toMatch(/plain English/i);
  });
});

describe("handleDraft (resolution path)", () => {
  const chatId = 424242;
  const artifactDir = path.join(ARTIFACT_ROOT, threadIdFor(chatId).replace(/[^a-zA-Z0-9_.-]/g, "_"));

  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    await fs.rm(artifactDir, { recursive: true, force: true }).catch(() => {});
  });

  it("tailors a real PDF and hands only the SEND to a kernel turn", async () => {
    // Tailoring and rendering happen outside the kernel (deterministic, no side
    // effects); only deliver_artifact — which is HITL-gated — runs through a
    // kernel turn, so the founder still taps to approve every outbound file.
    vi.doMock("../../../src/db/job-queries.js", () => ({
      getApplicationByBriefRank: vi.fn(async (section: string, rank: number) =>
        section === "do_today" && rank === 2 ? ROW : null,
      ),
      recordTailoringResult: vi.fn(async () => null),
    }));
    vi.doMock("../../../src/tools/jobhunt/tailor-cv.js", () => ({
      tailorCv: vi.fn(async () => ({
        success: true,
        tailoredMarkdown: "# Aquablu Tailored CV",
        matchedSkills: ["C++"],
        missingSkills: [],
        initialOverlapRatio: 0.6,
      })),
    }));
    vi.doMock("../../../src/tools/jobhunt/cv-renderer.js", () => ({
      renderCvToPdf: vi.fn(async () => ({ pdfBuffer: Buffer.from("%PDF-fake"), htmlString: "<html></html>" })),
    }));
    vi.doMock("../../../src/infra/storage/s3-client.js", () => ({
      uploadFile: vi.fn(async () => "ready-applications/2026-08-20/aquablu/key.pdf"),
    }));

    const { handleDraft } = await import("../../../src/gateway/jobhunt-commands.js");
    const runKernelText = vi.fn(async () => undefined);
    const reply = vi.fn(async () => undefined);

    await handleDraft({ match: "2", chat: { id: chatId }, reply } as never, { runKernelText });

    expect(runKernelText).toHaveBeenCalledOnce();
    const [, callText] = (runKernelText.mock.calls[0] ?? []) as unknown as [unknown, string?];
    expect(callText).toContain("deliver_artifact");
    expect(callText).toContain(artifactDir);
    expect(callText).toContain("Aquablu B.V");
    // Never the free-text draft path on the success branch.
    expect(callText).not.toContain("Draft a tailored application");

    // Only the "tailoring…" ack — a failure notice never fires on a success run.
    expect(reply).toHaveBeenCalledOnce();
    const [ackText] = (reply.mock.calls[0] ?? []) as unknown as [string?];
    expect(ackText).toContain("Tailoring your CV");

    const written = await fs.readdir(artifactDir);
    expect(written.length).toBe(1);
    expect(written[0]).toMatch(/^cv-aquablu.*\.pdf$/);
  });

  it("falls back to a text draft, and says so, when tailoring fails", async () => {
    // The stretch section carries `/draft`, not `/ask` — a years flag is an
    // application to write, not a question to send. Its ranks continue from DO
    // TODAY, so the same integer reaches exactly one row across both sections.
    vi.doMock("../../../src/db/job-queries.js", () => ({
      getApplicationByBriefRank: vi.fn(async (section: string, rank: number) =>
        section === "stretch" && rank === 3 ? ROW : null,
      ),
      recordTailoringResult: vi.fn(async () => null),
    }));
    vi.doMock("../../../src/tools/jobhunt/tailor-cv.js", () => ({
      tailorCv: vi.fn(async () => ({
        success: false,
        matchedSkills: [],
        missingSkills: [],
        initialOverlapRatio: 0,
        error: "LLM invocation failed: network blocked in tests",
      })),
    }));

    const { handleDraft } = await import("../../../src/gateway/jobhunt-commands.js");
    const runKernelText = vi.fn(async () => undefined);
    const reply = vi.fn(async () => undefined);

    await handleDraft({ match: "3", chat: { id: chatId }, reply } as never, { runKernelText });

    expect(runKernelText).toHaveBeenCalledOnce();
    const callArgs = runKernelText.mock.calls[0] as unknown as [string, string];
    expect(callArgs[1]).toContain("Aquablu B.V");
    // It must be a DRAFT instruction, never the question prompt: asking an
    // employer whether its five-year bar is firm invites the pre-emptive
    // rejection the stretch band exists to avoid.
    expect(callArgs[1]).toContain("Draft a tailored application");

    // Ack, then an explicit "this failed, falling back" notice — a founder
    // reading only the last message must know a text draft, not a PDF, is
    // what's about to arrive.
    expect(reply).toHaveBeenCalledTimes(2);
    const [fallbackText] = (reply.mock.calls[1] ?? []) as unknown as [string?];
    expect(fallbackText).toContain("Couldn't build a tailored PDF");
  });

  it("replies instead of drafting when the rank does not resolve", async () => {
    vi.doMock("../../../src/db/job-queries.js", () => ({
      getApplicationByBriefRank: vi.fn(async () => null),
    }));
    const { handleDraft } = await import("../../../src/gateway/jobhunt-commands.js");
    const runKernelText = vi.fn(async () => undefined);
    const reply = vi.fn(async () => undefined);

    await handleDraft({ match: "9", reply } as never, { runKernelText });

    expect(runKernelText).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const [replyArg1] = (reply.mock.calls[0] ?? []) as [unknown?];
    expect(String(replyArg1)).toContain("No row 9");
  });

  it("never reaches the database on an unparseable argument", async () => {
    const getApplicationByBriefRank = vi.fn(async () => ROW);
    vi.doMock("../../../src/db/job-queries.js", () => ({ getApplicationByBriefRank }));
    const { handleDraft } = await import("../../../src/gateway/jobhunt-commands.js");
    const reply = vi.fn(async () => undefined);

    await handleDraft({ match: "the first one", reply } as never, {
      runKernelText: vi.fn(async () => undefined),
    });

    expect(getApplicationByBriefRank).not.toHaveBeenCalled();
    const [replyArg2] = (reply.mock.calls[0] ?? []) as [unknown?];
    expect(String(replyArg2)).toContain("Usage:");
  });
});
