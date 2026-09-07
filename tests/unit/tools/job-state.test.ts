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
