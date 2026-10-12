/**
 * Unit tests — /draft.
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
import { parseRowArg, unresolvedMessage } from "../../../src/gateway/jobhunt-commands.js";
import { ARTIFACT_ROOT, TENANT } from "../../../src/core/config.js";
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

describe("handleDraft (resolution path)", () => {
  const chatId = 424242;
  const artifactDir = path.join(ARTIFACT_ROOT, `${TENANT}:${chatId}`.replace(/[^a-zA-Z0-9_.-]/g, "_"));

  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    await fs.rm(artifactDir, { recursive: true, force: true }).catch(() => {});
  });

  it("tailors a real PDF and sends it straight into the chat that asked — no kernel turn, no approval card", async () => {
    // UPDATED 2026-09-29. It used to hand the send to a kernel turn that called
    // the HITL-gated deliver_artifact. That cost three model calls and a tap to
    // put a file into the very chat that typed /draft; deliver_artifact always
    // sent to the founder's DM, so /wife_draft in the family group put Tashi's
    // CV in his private chat; and on 2026-09-17 the synthesizer told him the
    // Hitachi CV "failed" to deliver right after the tool said it had. Nothing
    // leaves Telegram here — applying stays his click on the employer's site.
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
    // Scripted, never live. `/draft` now writes a cover letter as well as the
    // CV, and an unmocked worker here would put a paid provider call in the
    // dev loop — which the cost rules forbid outright.
    vi.doMock("../../../src/agents/model.js", () => ({
      getWorkerModel: vi.fn(() => ({
        invoke: vi.fn(async () => ({
          content: [
            "Dear Hiring Team,",
            "",
            "I read the Embedded Software Engineer posting at Aquablu B.V and the water",
            "treatment control work is close to what I have been building.",
            "",
            "At Turicks I wrote the firmware-adjacent control loop in C++ and kept it",
            "running on hardware in the field for eighteen months without a rollback.",
            "",
            "I am available from September and would like to talk.",
            "",
            "Pushkar Verma",
          ].join("\n"),
        })),
      })),
    }));

    const { handleDraft } = await import("../../../src/gateway/jobhunt-commands.js");
    const reply = vi.fn(async () => undefined);
    const replyWithDocument = vi.fn(async () => undefined);

    await handleDraft({ match: "2", chat: { id: chatId }, reply, replyWithDocument } as never);

    expect(replyWithDocument).toHaveBeenCalledOnce();
    const [doc, docOpts] = (replyWithDocument.mock.calls[0] ?? []) as unknown as [
      { fileData?: unknown; filename?: string },
      { caption?: string }?,
    ];
    expect(String(doc.fileData)).toContain(artifactDir);
    expect(doc.filename).toMatch(/^cv-aquablu.*\.pdf$/);
    expect(docOpts?.caption).toContain("Aquablu B.V");

    // THREE messages on a success run: the "tailoring…" ack, the cover letter,
    // then the packet message carrying the apply link. A failure notice never
    // fires. UPDATED 2026-08-21 (twice): it asserted one reply while `/draft`
    // sent only a CV, then two once the cover letter landed. The third exists
    // because prod had 543 screened rows, 2 applications and not one
    // `deliver_artifact` in the action log — a PDF with no next step is where
    // this pipeline was stalling.
    expect(reply).toHaveBeenCalledTimes(3);
    const [ackText] = (reply.mock.calls[0] ?? []) as unknown as [string?];
    expect(ackText).toContain("Tailoring your CV");

    const [letterText] = (reply.mock.calls[1] ?? []) as unknown as [string?];
    expect(letterText).toContain("Cover letter");
    expect(letterText).toContain("Aquablu");
    // Delivered as copyable text, not a second file: the CV gets uploaded to
    // the form and the letter gets pasted into a box.
    expect(letterText).toContain("<pre>");
    expect(letterText).not.toMatch(/⚠/);

    // The packet message: what to tap. The ✅ button must carry the ROW's id (stable),
    // not the brief number, which is re-pinned on every rebuild.
    const [packetText, packetOpts] = (reply.mock.calls[2] ?? []) as unknown as [
      string?,
      { reply_markup?: { inline_keyboard: { callback_data?: string }[][] } }?,
    ];
    expect(packetText).toContain("Aquablu");
    expect(packetText).toContain("I applied");
    const buttons = packetOpts?.reply_markup?.inline_keyboard.flat() ?? [];
    expect(buttons.some((b) => b.callback_data === `jh:a:${ROW.id}`)).toBe(true);

    const written = await fs.readdir(artifactDir);
    expect(written.length).toBe(1);
    expect(written[0]).toMatch(/^cv-aquablu.*\.pdf$/);
  });

  it("says plainly that nothing was drafted when tailoring fails", async () => {
    // UPDATED 2026-10-10: the jobs process has no kernel, so the old free-text
    // fallback draft is gone. The reply must say nothing was drafted, so the
    // founder never waits for a text draft that will not come.
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
    const reply = vi.fn(async () => undefined);
    const replyWithDocument = vi.fn(async () => undefined);

    await handleDraft({ match: "3", chat: { id: chatId }, reply, replyWithDocument } as never);

    expect(replyWithDocument).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(2);
    const [failText] = (reply.mock.calls[1] ?? []) as unknown as [string?];
    expect(failText).toContain("Couldn't build a tailored PDF for Aquablu B.V");
    expect(failText).toContain("Nothing was drafted");
  });

  it("replies instead of drafting when the rank does not resolve", async () => {
    vi.doMock("../../../src/db/job-queries.js", () => ({
      getApplicationByBriefRank: vi.fn(async () => null),
    }));
    const { handleDraft } = await import("../../../src/gateway/jobhunt-commands.js");
    const reply = vi.fn(async () => undefined);

    await handleDraft({ match: "9", reply } as never);

    expect(reply).toHaveBeenCalledOnce();
    const [replyArg1] = (reply.mock.calls[0] ?? []) as [unknown?];
    expect(String(replyArg1)).toContain("No row 9");
  });

  it("never reaches the database on an unparseable argument", async () => {
    const getApplicationByBriefRank = vi.fn(async () => ROW);
    vi.doMock("../../../src/db/job-queries.js", () => ({ getApplicationByBriefRank }));
    const { handleDraft } = await import("../../../src/gateway/jobhunt-commands.js");
    const reply = vi.fn(async () => undefined);

    await handleDraft({ match: "the first one", reply } as never);

    expect(getApplicationByBriefRank).not.toHaveBeenCalled();
    const [replyArg2] = (reply.mock.calls[0] ?? []) as [unknown?];
    expect(String(replyArg2)).toContain("Usage:");
  });
});
