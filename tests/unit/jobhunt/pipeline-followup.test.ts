/**
 * T3 (2026-08-25) — the funnel's back half.
 *
 * `listLiveApplications`, `followups_sent`, and the `replied`/`rejected`
 * stages all existed with zero writers or callers before this. These tests
 * cover the two sweeps that finally use them: the weekly digest (pure
 * formatting, no database needed) and the day-7/day-14 follow-up nudge
 * (mocked DB + Telegram, since the sweep itself is I/O).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";

const listLiveApplications = vi.fn();
const listFollowupCandidates = vi.fn();
const incrementFollowupsSent = vi.fn();
const sendToChat = vi.fn();

vi.mock("../../../src/db/job-queries.js", () => ({
  listLiveApplications: (...args: unknown[]) => listLiveApplications(...args),
  listFollowupCandidates: (...args: unknown[]) => listFollowupCandidates(...args),
  incrementFollowupsSent: (...args: unknown[]) => incrementFollowupsSent(...args),
}));
vi.mock("../../../src/infra/telegram-send.js", () => ({
  sendToChat: (...args: unknown[]) => sendToChat(...args),
}));

const { formatPipelineDigest, formatFollowupNudge, runPipelineDigest, runFollowupSweep } = await import(
  "../../../src/tools/jobhunt/pipeline-followup.js"
);

const NOW = new Date("2026-08-25T12:00:00Z");

function row(overrides: Partial<JobApplication> = {}): JobApplication {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenant_id: "turicks",
    company: "Ockto",
    title: "Senior Backend Engineer",
    stage: "applied",
    applied_at: new Date("2026-08-18T12:00:00Z"),
    last_contact_at: new Date("2026-08-18T12:00:00Z"),
    followups_sent: 0,
    ...overrides,
  } as JobApplication;
}

beforeEach(() => {
  listLiveApplications.mockReset();
  listFollowupCandidates.mockReset();
  incrementFollowupsSent.mockReset();
  sendToChat.mockReset();
});

describe("formatPipelineDigest", () => {
  it("says so plainly when nothing is live, rather than an empty message", () => {
    const text = formatPipelineDigest([], NOW);
    expect(text.toLowerCase()).toContain("nothing live");
  });

  it("numbers rows from 1, with the /replied and /rejected hint for each", () => {
    const rows = [row({ company: "Ockto" }), row({ company: "Mollie", id: "2" })];
    const text = formatPipelineDigest(rows, NOW);
    expect(text).toContain("1. Ockto");
    expect(text).toContain("/replied 1");
    expect(text).toContain("/rejected 1");
    expect(text).toContain("2. Mollie");
    expect(text).toContain("/replied 2");
  });

  it("shows days since applied for a still-applied row", () => {
    // applied_at 7 days before NOW
    const text = formatPipelineDigest([row({ applied_at: new Date("2026-08-18T12:00:00Z") })], NOW);
    expect(text).toContain("7d ago");
  });

  it("escapes company/title so a stray < in a job title cannot break the message", () => {
    const text = formatPipelineDigest([row({ title: "Eng <script>" })], NOW);
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});

describe("formatFollowupNudge", () => {
  it("labels the first nudge as day 7 and the second as day 14", () => {
    const first = formatFollowupNudge(row(), 1, NOW);
    const second = formatFollowupNudge(row(), 2, NOW);
    expect(first).toContain("day 7");
    expect(second).toContain("day 14");
  });

  it("includes a ready-to-send draft naming the role", () => {
    const text = formatFollowupNudge(row({ title: "Senior Backend Engineer" }), 1, NOW);
    expect(text).toContain("Senior Backend Engineer");
    expect(text.toLowerCase()).toContain("draft");
  });
});

describe("runPipelineDigest", () => {
  it("reads listLiveApplications and sends the formatted digest", async () => {
    listLiveApplications.mockResolvedValueOnce([row()]).mockResolvedValue([]);
    await runPipelineDigest();
    expect(sendToChat).toHaveBeenCalledTimes(1);
    const [sentText] = (sendToChat.mock.calls[0] ?? []) as [string?];
    expect(sentText).toContain("Ockto");
  });

  it("still speaks once when NO profile has live rows", async () => {
    // Per-profile digests were introduced with a `rows.length > 0` skip, which
    // means an all-empty pipeline sends nothing at all. From Telegram that is
    // indistinguishable from a crashed cron — the failure that cost this
    // pipeline fifteen silent hours on 2026-08-21.
    listLiveApplications.mockResolvedValue([]);
    await runPipelineDigest();
    expect(sendToChat).toHaveBeenCalledTimes(1);
    const [sentText] = (sendToChat.mock.calls[0] ?? []) as [string?];
    expect(sentText).toContain("Nothing live right now");
  });
});

describe("runFollowupSweep", () => {
  it("sends a nudge and increments followups_sent for each candidate", async () => {
    listFollowupCandidates.mockResolvedValueOnce([row({ followups_sent: 0 }), row({ id: "2", followups_sent: 1 })]).mockResolvedValue([]);
    sendToChat.mockResolvedValue(undefined);
    incrementFollowupsSent.mockResolvedValue(undefined);

    const outcome = await runFollowupSweep(NOW);

    expect(outcome).toEqual({ sent: 2, failed: 0 });
    expect(sendToChat).toHaveBeenCalledTimes(2);
    expect(incrementFollowupsSent).toHaveBeenCalledTimes(2);
  });

  it("one failed send does not stop the rest, and does not increment for the failed row", async () => {
    listFollowupCandidates.mockResolvedValueOnce([row({ id: "a" }), row({ id: "b" })]).mockResolvedValue([]);
    sendToChat.mockRejectedValueOnce(new Error("Telegram down")).mockResolvedValueOnce(undefined);

    const outcome = await runFollowupSweep(NOW);

    expect(outcome).toEqual({ sent: 1, failed: 1 });
    expect(incrementFollowupsSent).toHaveBeenCalledTimes(1);
    expect(incrementFollowupsSent).toHaveBeenCalledWith("b", "turicks");
  });

  it("does nothing when there are no candidates", async () => {
    listFollowupCandidates.mockResolvedValue([]);
    const outcome = await runFollowupSweep(NOW);
    expect(outcome).toEqual({ sent: 0, failed: 0 });
    expect(sendToChat).not.toHaveBeenCalled();
  });
});
