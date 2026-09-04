/**
 * /replied and /rejected (T3, 2026-08-25) — close the loop /applied opens.
 *
 * These CANNOT reuse resolveBriefRow like /draft and /applied do: by the time
 * a row is worth marking replied/rejected, /applied has already nulled its
 * brief_rank (see the comment on updateApplicationStage's clearBriefRank).
 * They resolve against listLiveApplications()'s own ordering instead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";

describe("handleReplied / handleRejected", () => {
  beforeEach(() => vi.resetModules());

  const LIVE_ROW = {
    id: "live-row-1",
    company: "Ockto",
    title: "Senior Backend Engineer",
    stage: "applied",
  } as unknown as JobApplication;

  it("marks the Nth live application replied and echoes the company name back", async () => {
    const updateApplicationStage = vi.fn(async () => LIVE_ROW);
    vi.doMock("../../../src/db/job-queries.js", () => ({
      listLiveApplications: vi.fn(async () => [LIVE_ROW]),
      updateApplicationStage,
    }));
    const { handleReplied } = await import("../../../src/gateway/live-application-commands.js");
    const reply = vi.fn(async () => undefined);

    await handleReplied({ match: "1", reply } as never);

    expect(updateApplicationStage).toHaveBeenCalledWith(
      "live-row-1",
      "replied",
      expect.objectContaining({ lastContactAt: expect.any(Date) }),
    );
    const [replyArg] = (reply.mock.calls[0] ?? []) as [unknown?];
    expect(String(replyArg)).toContain("Ockto");
    expect(String(replyArg)).toContain("replied");
  });

  it("marks the Nth live application rejected", async () => {
    const updateApplicationStage = vi.fn(async () => LIVE_ROW);
    vi.doMock("../../../src/db/job-queries.js", () => ({
      listLiveApplications: vi.fn(async () => [LIVE_ROW]),
      updateApplicationStage,
    }));
    const { handleRejected } = await import("../../../src/gateway/live-application-commands.js");
    const reply = vi.fn(async () => undefined);

    await handleRejected({ match: "1", reply } as never);

    expect(updateApplicationStage).toHaveBeenCalledWith("live-row-1", "rejected", expect.anything());
    const [replyArg] = (reply.mock.calls[0] ?? []) as [unknown?];
    expect(String(replyArg)).toContain("Ockto");
    expect(String(replyArg)).toContain("rejected");
  });

  it("refuses a number past the end of the live list, without touching the database write path", async () => {
    const updateApplicationStage = vi.fn();
    vi.doMock("../../../src/db/job-queries.js", () => ({
      listLiveApplications: vi.fn(async () => [LIVE_ROW]), // only 1 row
      updateApplicationStage,
    }));
    const { handleReplied } = await import("../../../src/gateway/live-application-commands.js");
    const reply = vi.fn(async () => undefined);

    await handleReplied({ match: "5", reply } as never); // asks for row 5 of 1

    expect(updateApplicationStage).not.toHaveBeenCalled();
    const [replyArg] = (reply.mock.calls[0] ?? []) as [unknown?];
    // Must NOT say "the latest brief" — these numbers come from the live list,
    // not a brief, and that message would send the founder to the wrong place.
    expect(String(replyArg)).not.toContain("brief");
    expect(String(replyArg)).toContain("live applications");
  });

  it("gives usage on a non-numeric argument, without querying the database", async () => {
    const listLiveApplications = vi.fn();
    vi.doMock("../../../src/db/job-queries.js", () => ({
      listLiveApplications,
      updateApplicationStage: vi.fn(),
    }));
    const { handleRejected } = await import("../../../src/gateway/live-application-commands.js");
    const reply = vi.fn(async () => undefined);

    await handleRejected({ match: "the ockto one", reply } as never);

    expect(listLiveApplications).not.toHaveBeenCalled();
    const [replyArg] = (reply.mock.calls[0] ?? []) as [unknown?];
    expect(String(replyArg)).toContain("Usage:");
  });

  // T4, 2026-09-05: neither command resolved a profile at all before this —
  // listLiveApplications only filtered by tenant, so with a second candidate
  // registered "row 2" could point at either person's application.
  it("scopes the live-application list to the named profile", async () => {
    const listLiveApplications = vi.fn(async () => [LIVE_ROW]);
    vi.doMock("../../../src/db/job-queries.js", () => ({
      listLiveApplications,
      updateApplicationStage: vi.fn(async () => LIVE_ROW),
    }));
    const { handleReplied } = await import("../../../src/gateway/live-application-commands.js");
    const reply = vi.fn(async () => undefined);

    await handleReplied({ match: "wife 1", reply } as never);

    expect(listLiveApplications).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "wife-nl-finance", tenantId: "turicks" }),
    );
  });

  it("bare (no profile named) still scopes to the default profile, not every profile merged", async () => {
    const listLiveApplications = vi.fn(async () => [LIVE_ROW]);
    vi.doMock("../../../src/db/job-queries.js", () => ({
      listLiveApplications,
      updateApplicationStage: vi.fn(async () => LIVE_ROW),
    }));
    const { handleRejected } = await import("../../../src/gateway/live-application-commands.js");
    const reply = vi.fn(async () => undefined);

    await handleRejected({ match: "1", reply } as never);

    expect(listLiveApplications).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "pushkar-nl-tech" }),
    );
  });

  it("refuses an unrecognised profile word rather than guessing whose row it means", async () => {
    const listLiveApplications = vi.fn();
    vi.doMock("../../../src/db/job-queries.js", () => ({
      listLiveApplications,
      updateApplicationStage: vi.fn(),
    }));
    const { handleReplied } = await import("../../../src/gateway/live-application-commands.js");
    const reply = vi.fn(async () => undefined);

    await handleReplied({ match: "bogus 1", reply } as never);

    expect(listLiveApplications).not.toHaveBeenCalled();
    const [replyArg] = (reply.mock.calls[0] ?? []) as [unknown?];
    expect(String(replyArg)).toContain("bogus");
  });
});
