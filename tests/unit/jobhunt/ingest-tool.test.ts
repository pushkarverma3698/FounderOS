/**
 * Unit tests — `ingest_jobs` (the ON-DEMAND, chat-triggered pull) must fetch
 * and screen for the CANDIDATE it was asked about.
 *
 * 2026-09-07: `runJobIngest` called `screenBatch(fetched.postings)` with no
 * profile at all — the one caller of `screenBatch` in the whole codebase that
 * omitted it (every other caller, `free-ingest.ts` and the daily sweep in
 * `ingest.ts`, already threads a profile through). Worse, its title default
 * (`DEFAULT_TITLES` in ats-source.ts) is `titlesForTracks(TRACK_PRIORITY)` —
 * a module-wide constant matching Pushkar's own AI/backend/frontend/fullstack
 * tracks, not derived from any profile. An on-demand pull for Tashi with no
 * `titles` override fetched tech postings, then correctly screened every one
 * of them as off-track for a finance candidate — which reads exactly like "no
 * jobs exist for her," when the actual defect was the fetch query itself.
 *
 * These pin: a given profile's own track titles feed the fetch when the
 * caller didn't override them (mirroring how `runPooledIngest`, the daily
 * sweep, already resolves `profile.tracks[track]?.titles`), an explicit
 * `titles` override is still respected verbatim, and the resolved profile
 * reaches `screenBatch` so the verdicts score against the right candidate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WIFE_FINANCE_PROFILE } from "../../../src/tools/jobhunt/profiles/wife-nl-finance.js";
import { PUSHKAR_PROFILE } from "../../../src/tools/jobhunt/profile-config.js";

const mockFetchAtsPostings = vi.fn();
vi.mock("../../../src/tools/jobhunt/ats-source.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  fetchAtsPostings: mockFetchAtsPostings,
}));

const mockScreenBatch = vi.fn();
vi.mock("../../../src/tools/jobhunt/ingest.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  screenBatch: mockScreenBatch,
}));

const { runJobIngest, ingestJobsTool } = await import("../../../src/tools/jobhunt/ingest-tool.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchAtsPostings.mockResolvedValue({ ok: true, postings: [] });
  mockScreenBatch.mockResolvedValue([]);
});

describe("ingest_jobs — profile argument", () => {
  it("exposes profileId in its input schema", () => {
    const props = ingestJobsTool.input_schema?.properties as Record<string, unknown> | undefined;
    expect(props).toHaveProperty("profileId");
  });

  it("defaults to the founder's own track titles when no profile or titles are given — unchanged from before", async () => {
    await runJobIngest();
    const query = mockFetchAtsPostings.mock.calls[0]?.[0] as { titles?: string[] };
    expect(query.titles).toEqual(expect.arrayContaining(["AI Engineer:*"]));
  });

  it("fetches the NAMED profile's own track titles, not the founder's, when titles are not overridden", async () => {
    await runJobIngest({}, WIFE_FINANCE_PROFILE);
    const query = mockFetchAtsPostings.mock.calls[0]?.[0] as { titles?: string[] };
    expect(query.titles).toEqual(expect.arrayContaining(["FP&A Analyst:*"]));
    expect(query.titles).not.toEqual(expect.arrayContaining(["AI Engineer:*"]));
  });

  it("respects an explicit titles override verbatim instead of the profile default", async () => {
    await runJobIngest({ titles: ["Custom Title:*"] }, WIFE_FINANCE_PROFILE);
    const query = mockFetchAtsPostings.mock.calls[0]?.[0] as { titles?: string[] };
    expect(query.titles).toEqual(["Custom Title:*"]);
  });

  it("screens the fetched batch against the named profile, not the founder's default", async () => {
    await runJobIngest({}, WIFE_FINANCE_PROFILE);
    expect(mockScreenBatch).toHaveBeenCalledWith(expect.anything(), WIFE_FINANCE_PROFILE);
  });

  it("tool execute() resolves a profileId argument through to runJobIngest's fetch and screen", async () => {
    await ingestJobsTool.execute({ profileId: "wife-nl-finance" });
    const query = mockFetchAtsPostings.mock.calls[0]?.[0] as { titles?: string[] };
    expect(query.titles).toEqual(expect.arrayContaining(["FP&A Analyst:*"]));
    expect(mockScreenBatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "wife-nl-finance" }));
  });

  it("tool execute() omitting profileId still screens against the founder's own profile", async () => {
    await ingestJobsTool.execute({});
    expect(mockScreenBatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: PUSHKAR_PROFILE.id }));
  });
});
