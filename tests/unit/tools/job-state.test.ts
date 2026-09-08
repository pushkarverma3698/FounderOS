/**
 * Unit tests for `job_state` tool and `queryJobState` helper.
 *
 * 2026-09-07: `job_state` had no profile filter at all — every call mixed
 * both candidates' rows regardless of what the founder actually asked about
 * (see job-queries.ts's queryJobState docblock and profile-config.ts's
 * DEFAULT_PROFILE_ID history). These pin the fix: the tool resolves a
 * `profile` argument (id, first name, or alias) to the right profileId
 * before calling queryJobState, defaults to the founder's own queue when
 * omitted (never "everyone"), and refuses loudly on an unrecognised name
 * rather than silently querying the wrong — or no — filter.
 */

import { describe, it, expect, vi } from "vitest";
import { jobStateTool } from "../../../src/tools/job-state.js";
import { queryJobState, ALL_PROFILES } from "../../../src/db/job-queries.js";

vi.mock("../../../src/db/job-queries.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/job-queries.js")>(
    "../../../src/db/job-queries.js",
  );
  return {
    ALL_PROFILES: actual.ALL_PROFILES,
    queryJobState: vi.fn().mockResolvedValue({ count: 5, total: 10, rows: [{}, {}, {}, {}, {}] }),
  };
});

describe("job_state tool & queryJobState", () => {
  it("defines read-only metadata and input schema", () => {
    expect(jobStateTool.name).toBe("job_state");
    expect(jobStateTool.description).toContain("Deterministic read of captured job applications");
    const props = jobStateTool.input_schema?.properties as Record<string, unknown> | undefined;
    expect(props).toHaveProperty("stage");
    expect(props).toHaveProperty("section");
    expect(props).toHaveProperty("applied");
    expect(props).toHaveProperty("fullDetails");
    expect(props).toHaveProperty("profile");
  });

  it("queries job state returning count, total, and rows", async () => {
    const res = await queryJobState({ limit: 10 });
    expect(typeof res.count).toBe("number");
    expect(typeof res.total).toBe("number");
    expect(Array.isArray(res.rows)).toBe(true);
  });

  it("tool execution returns valid JSON response envelope", async () => {
    const res = await jobStateTool.execute({ limit: 5 });
    expect(res.success).toBe(true);
    if (res.success && typeof res.data === "string") {
      const parsed = JSON.parse(res.data);
      expect(parsed).toHaveProperty("count");
      expect(parsed).toHaveProperty("total");
      expect(parsed).toHaveProperty("rows");
    }
  });

  it("omitting profile leaves profileId undefined — queryJobState defaults to the founder's own queue, never a mix", async () => {
    vi.mocked(queryJobState).mockClear();
    await jobStateTool.execute({ limit: 5 });
    expect(vi.mocked(queryJobState)).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: undefined }),
    );
  });

  it("resolves a first-name alias to the registered profile id", async () => {
    vi.mocked(queryJobState).mockClear();
    await jobStateTool.execute({ limit: 5, profile: "Tashi" });
    expect(vi.mocked(queryJobState)).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "wife-nl-finance" }),
    );
  });

  it("resolves the canonical profile id unchanged", async () => {
    vi.mocked(queryJobState).mockClear();
    await jobStateTool.execute({ limit: 5, profile: "pushkar-nl-tech" });
    expect(vi.mocked(queryJobState)).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "pushkar-nl-tech" }),
    );
  });

  it('resolves "all" to the ALL_PROFILES sentinel for a genuine cross-candidate query', async () => {
    vi.mocked(queryJobState).mockClear();
    await jobStateTool.execute({ limit: 5, profile: "all" });
    expect(vi.mocked(queryJobState)).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: ALL_PROFILES }),
    );
  });

  it("refuses an unrecognised profile loudly instead of silently querying the wrong or no filter", async () => {
    vi.mocked(queryJobState).mockClear();
    const res = await jobStateTool.execute({ limit: 5, profile: "someone-unregistered" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("someone-unregistered");
      expect(res.error).toContain("wife-nl-finance");
    }
    expect(vi.mocked(queryJobState)).not.toHaveBeenCalled();
  });
});

/**
 * `section` vs `track` — two vocabularies, one silent zero (2026-09-07 prod).
 *
 * `brief_section` holds `do_today | stretch | ask | standing`. The tool's own
 * description advertised the DISPLAY headings ("DO TODAY", "ONE QUESTION
 * AWAY"), which no row has ever carried, and `job_brief` prints the `track`
 * column ("accountant 4 · fpa 7"). Every one of those spellings passed straight
 * through to an `eq()` and returned 0 rows with `success: true` — so the worker
 * read an empty result as "nothing matches", retried other spellings, and
 * burned the run's whole token budget reconciling a mismatch that was never a
 * data fact. Silence was the defect; these pin the loudness.
 */
describe("job_state — section is validated, track is its own filter", () => {
  it("accepts the display heading a founder would read off the brief", async () => {
    vi.mocked(queryJobState).mockClear();
    const res = await jobStateTool.execute({ section: "DO TODAY" });
    expect(res.success).toBe(true);
    expect(vi.mocked(queryJobState)).toHaveBeenCalledWith(
      expect.objectContaining({ section: "do_today" }),
    );
  });

  it('accepts "ONE QUESTION AWAY" as the ask section', async () => {
    vi.mocked(queryJobState).mockClear();
    await jobStateTool.execute({ section: "ONE QUESTION AWAY" });
    expect(vi.mocked(queryJobState)).toHaveBeenCalledWith(
      expect.objectContaining({ section: "ask" }),
    );
  });

  it("passes a canonical DB value through unchanged", async () => {
    vi.mocked(queryJobState).mockClear();
    await jobStateTool.execute({ section: "stretch" });
    expect(vi.mocked(queryJobState)).toHaveBeenCalledWith(
      expect.objectContaining({ section: "stretch" }),
    );
  });

  it("refuses a TRACK passed as a section, and names the argument that does work", async () => {
    vi.mocked(queryJobState).mockClear();
    const res = await jobStateTool.execute({ section: "accountant" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("accountant");
      expect(res.error).toContain("do_today");
      expect(res.error).toContain("track");
    }
    // The point of the fix: no query is issued, so no empty result can be
    // mistaken for "the market has none of these".
    expect(vi.mocked(queryJobState)).not.toHaveBeenCalled();
  });

  it("filters by track when track is what was meant", async () => {
    vi.mocked(queryJobState).mockClear();
    const res = await jobStateTool.execute({ track: "accountant" });
    expect(res.success).toBe(true);
    expect(vi.mocked(queryJobState)).toHaveBeenCalledWith(
      expect.objectContaining({ track: "accountant" }),
    );
  });

  it("refuses an unknown track loudly, listing the tracks that exist", async () => {
    vi.mocked(queryJobState).mockClear();
    const res = await jobStateTool.execute({ track: "astronaut" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("astronaut");
      expect(res.error).toContain("accountant");
    }
    expect(vi.mocked(queryJobState)).not.toHaveBeenCalled();
  });

  it("exposes track in the input schema so the worker can reach it", () => {
    const props = jobStateTool.input_schema?.properties as Record<string, unknown> | undefined;
    expect(props).toHaveProperty("track");
  });
});
