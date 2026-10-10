/**
 * Draft and applied by the id an alert printed.
 *
 * THE BUG. An alert printed a row number. Three days later the queue had been re-ranked a hundred times and
 * that row was a different company. The id is the role: it keeps resolving after every re-rank, and the old
 * position-style commands keep working exactly as before.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { shortJobId } from "../../../src/tools/jobhunt/job-ref.js";
import { formatNewRowsAlert } from "../../../src/tools/jobhunt/sweep-heartbeat.js";
import { dedupeKey } from "../../../src/tools/jobhunt/filters.js";
import type { IngestLine } from "../../../src/tools/jobhunt/ingest-batch.js";
import type { JobApplication } from "../../../src/db/schema.js";

const NEXPERIA_ID = "3a9f2c1d-8b47-4e60-9d15-7c2e0a6b41f8";
const BOSCH_ID = "81e2aa40-1111-4222-8333-444455556666";

function role(id: string, profileId: string, company: string, rank: number | null, stage = "screened"): JobApplication {
  const row = {} as Record<string, unknown>;
  row.id = id;
  row.tenant_id = "turicks";
  row.profile_id = profileId;
  row.company = company;
  row.title = "Finance Controller";
  row.route = "partner-permit";
  row.stage = stage;
  row.brief_rank = rank;
  row.description = "Month-end close. ".repeat(30);
  return row as unknown as JobApplication;
}

const NEXPERIA = role(NEXPERIA_ID, "wife-nl-finance", "Nexperia", null);
const BOSCH = role(BOSCH_ID, "pushkar-nl-tech", "Bosch", 4);

/** The queue today: whoever is ranked 4 is Bosch, whatever alert said 4 three days ago. */
const getApplicationByBriefRank = vi.fn(async (_section: string, rank: number) => (rank === 4 ? BOSCH : null));
const findApplicationsByIdPrefix = vi.fn(async (hex: string) =>
  [NEXPERIA, BOSCH].filter((r) => r.id.split("-").join("").startsWith(hex)),
);
const markRowApplied = vi.fn(async (_row: JobApplication) => ({ ok: true as const, already: false }));
const reply = vi.fn(async (_text: string) => undefined);

type Rec = Record<string, unknown>;
const SRC = "../../../src/";
const mockModule = (file: string, factory: () => unknown) => vi.doMock(SRC + file, factory as never);
const actual = async (file: string) => (await vi.importActual(SRC + file)) as Rec;
const NO_RENDERER = "test: no renderer";
const failedPacket = async () => ({ ok: false, reason: NO_RENDERER });
const withActual = (file: string, over: Rec) => async () => ({ ...(await actual(file)), ...over });
const mockDb = () => mockModule("db/job-queries.js", () => ({ getApplicationByBriefRank }));
const mockRefDb = () => mockModule("db/job-ref-queries.js", () => ({ findApplicationsByIdPrefix }));
const mockButtons = () => mockModule("gateway/jobhunt-buttons.js", withActual("gateway/jobhunt-buttons.js", { markRowApplied }));
const mockPacket = () => mockModule("tools/jobhunt/apply-packet.js", withActual("tools/jobhunt/apply-packet.js", { buildApplicationPacket: failedPacket }));
beforeEach(() => (vi.resetModules(), vi.clearAllMocks(), mockDb(), mockRefDb(), mockButtons(), mockPacket()));

const ctxFor = (match: string) => ({ match, reply }) as never;
/** Every reply, joined: the "Tailoring your CV for <company>" line names the row the id resolved to. */
const replies = () => reply.mock.calls.map((c) => String(c[0])).join("\n");
const firstReply = () => String(reply.mock.calls[0]?.[0] ?? "");

/** The command a person would tap on a 3-day-old alert, taken from the alert text itself. */
function commandFromAlert(): string {
  const found = {} as Record<string, unknown>;
  found.company = "Nexperia";
  found.title = "Finance Controller";
  found.outcome = "pass";
  found.detail = "";
  found.isNew = true;
  const ids = new Map([[dedupeKey("Nexperia", "Finance Controller"), shortJobId(NEXPERIA_ID)]]);
  const selector = "tashi";
  const text = formatNewRowsAlert([found as unknown as IngestLine], null, "Tashi", { selector, ids });
  const codes = text.split("<code>").map((part) => part.split("</code>")[0] ?? "");
  const printed = codes.find((c) => c.startsWith("/draft "));
  expect(printed, text).toBeDefined();
  return (printed ?? "").replace("/draft ", "");
}
const TYPED = "tashi j3a9f2c1";
const draftModule = () => import("../../../src/gateway/jobhunt-commands.js");

describe("draft by id", () => {
  it("opens the same company after the queue was re-ranked", async () => {
    expect(commandFromAlert()).toBe(TYPED);
    const { handleDraft } = await draftModule();
    await handleDraft(ctxFor(TYPED));
    expect(replies()).toContain("Nexperia");
    expect(getApplicationByBriefRank).not.toHaveBeenCalled();
  });
});

describe("draft by position still works", () => {
  it("resolves a plain number against the live brief, as before", async () => {
    const { handleDraft } = await draftModule();
    await handleDraft(ctxFor("4"));
    expect(getApplicationByBriefRank).toHaveBeenCalled();
    expect(replies()).toContain("Bosch");
  });
});

describe("an id that cannot be acted on is refused out loud", () => {
  it("names the right command when the id belongs to the other candidate", async () => {
    const { handleDraft } = await draftModule();
    await handleDraft(ctxFor("j3a9f2c1"));
    expect(firstReply()).toContain("draft " + TYPED);
    expect(replies()).not.toContain("Tailoring");
  });

  it("never falls back to a position when the id is unknown", async () => {
    const { handleDraft } = await draftModule();
    await handleDraft(ctxFor("tashi jabcdef0"));
    expect(firstReply()).toContain("jabcdef0");
    expect(getApplicationByBriefRank).not.toHaveBeenCalled();
    expect(replies()).not.toContain("Tailoring");
  });

  it("says so when a short id matches two roles", async () => {
    findApplicationsByIdPrefix.mockResolvedValueOnce([NEXPERIA, NEXPERIA]);
    const { handleDraft } = await draftModule();
    await handleDraft(ctxFor(TYPED));
    expect(firstReply()).toContain("more than one role");
    expect(replies()).not.toContain("Tailoring");
  });

  it("does not redraft a role that was already applied to", async () => {
    findApplicationsByIdPrefix.mockResolvedValueOnce([role(NEXPERIA_ID, "wife-nl-finance", "Nexperia", null, "applied")]);
    const { handleDraft } = await draftModule();
    await handleDraft(ctxFor(TYPED));
    expect(firstReply()).toContain("already applied");
    expect(replies()).not.toContain("Tailoring");
  });
});

describe("applied takes the same id", () => {
  it("/applied closes the same company", async () => {
    const { handleApplied } = await draftModule();
    await handleApplied(ctxFor(TYPED));
    expect(markRowApplied).toHaveBeenCalledWith(NEXPERIA);
    expect(firstReply()).toContain("Nexperia");
  });
});
