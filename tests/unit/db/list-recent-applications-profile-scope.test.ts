/**
 * listRecentApplications must scope by profile, not just tenant.
 * =================================================================
 * scripts/jobhunt-backfill-gates.ts calls this with no profile filter at all,
 * so its 1000-row read spans both candidates' rows and re-screens every one of
 * them under whichever profile getProfile() defaults to. Every sibling query
 * function in this file already scopes through profileCondition() — this one
 * never adopted it. See job-queries.ts's own header comment for the named
 * precedent ("/draft 3 resolving to the other candidate's row is that bug").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { jobApplications } from "../../../src/db/schema.js";
import { listRecentApplications, ALL_PROFILES } from "../../../src/db/job-queries.js";
import { DEFAULT_PROFILE_ID } from "../../../src/tools/jobhunt/profile-config.js";

const captured: unknown[] = [];

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          captured.push(w);
          return { orderBy: () => ({ limit: async () => [] }) };
        },
      }),
    }),
  }),
}));

describe("listRecentApplications — profile scoping", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("scopes to the given profileId, not tenant alone", async () => {
    await listRecentApplications({ profileId: "wife-nl-finance" });
    expect(captured[0]).toEqual(
      and(eq(jobApplications.tenant_id, "turicks"), eq(jobApplications.profile_id, "wife-nl-finance")),
    );
  });

  it("defaults to DEFAULT_PROFILE_ID when profileId is omitted — never to every profile", async () => {
    await listRecentApplications({});
    expect(captured[0]).toEqual(
      and(eq(jobApplications.tenant_id, "turicks"), eq(jobApplications.profile_id, DEFAULT_PROFILE_ID)),
    );
  });

  it("returns to tenant-only scoping when ALL_PROFILES is passed explicitly", async () => {
    await listRecentApplications({ profileId: ALL_PROFILES });
    expect(captured[0]).toEqual(eq(jobApplications.tenant_id, "turicks"));
  });
});
