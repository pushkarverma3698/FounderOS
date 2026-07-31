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

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseRowArg,
  unresolvedMessage,
  draftInstruction,
  askInstruction,
} from "../../../src/gateway/jobhunt-commands.js";
import { unknownCommandReply } from "../../../src/gateway/commands.js";
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
  beforeEach(() => vi.resetModules());

  it("runs a kernel turn for the row pinned at that rank", async () => {
    vi.doMock("../../../src/db/job-queries.js", () => ({
      getApplicationByBriefRank: vi.fn(async (section: string, rank: number) =>
        section === "do_today" && rank === 2 ? ROW : null,
      ),
    }));
    const { handleDraft } = await import("../../../src/gateway/jobhunt-commands.js");
    const runKernelText = vi.fn(async () => undefined);
    const reply = vi.fn(async () => undefined);

    await handleDraft({ match: "2", reply } as never, { runKernelText });

    expect(runKernelText).toHaveBeenCalledOnce();
    expect(runKernelText.mock.calls[0]![1]).toContain("Aquablu B.V");
    expect(reply).not.toHaveBeenCalled();
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
    expect(String(reply.mock.calls[0]![0])).toContain("No row 9");
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
    expect(String(reply.mock.calls[0]![0])).toContain("Usage:");
  });
});
