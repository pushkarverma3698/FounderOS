import { describe, it, expect, vi, beforeEach } from "vitest";

const findRefs = vi.fn(async (..._a: unknown[]) => [] as Array<{ company: string; url: string | null; externalId: string | null }>);
const findByKey = vi.fn(async (..._a: unknown[]) => null);

vi.mock("../../../src/db/job-known-queries.js", () => ({ findKnownPostingRefs: (...a: unknown[]) => findRefs(...a) }));
vi.mock("../../../src/db/job-queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, findApplicationByDedupeKey: (...a: unknown[]) => findByKey(...a) };
});

const { normalizeJobUrl, buildKnownIndex, isKnownPosting } = await import("../../../src/tools/jobhunt/known-postings.js");
const { keepUnseen } = await import("../../../src/tools/jobhunt/free-ingest.js");

const cand = (name: string, title: string, url: string, externalId: string) =>
  ({ board: { name, token: name.toLowerCase(), platform: "greenhouse" }, title, url, externalId, location: "", postedAt: null, description: null }) as never;

beforeEach(() => {
  findRefs.mockClear();
  findByKey.mockClear();
  findRefs.mockResolvedValue([]);
});

describe("normalizeJobUrl", () => {
  it("ignores tracking params, fragment, host case and trailing slash, keeps id params", () => {
    expect(normalizeJobUrl("https://Jobs.Example.com/o/123/?utm_source=x&gh_src=y#apply")).toBe("jobs.example.com/o/123");
    expect(normalizeJobUrl("https://boards.x.com/job?gh_jid=42&utm_medium=m")).toBe("boards.x.com/job?gh_jid=42");
  });
  it("returns null for a non-URL", () => {
    expect(normalizeJobUrl("not a url")).toBeNull();
  });
});

describe("isKnownPosting", () => {
  it("matches on board + external id but not across boards", () => {
    const idx = buildKnownIndex([{ company: "Ramp", url: null, externalId: "77" }]);
    expect(isKnownPosting({ company: "Ramp", url: "https://a.io/x", externalId: "77" }, idx)).toBe(true);
    expect(isKnownPosting({ company: "Other", url: "https://a.io/y", externalId: "77" }, idx)).toBe(false);
  });
});

describe("keepUnseen: renamed postings", () => {
  it("drops PwC and Ramp postings whose title changed but URL is the same", async () => {
    findRefs.mockResolvedValue([
      { company: "PwC", url: "https://pwc.example/jobs/9001", externalId: null },
      { company: "Ramp", url: "https://boards.greenhouse.io/ramp/jobs/555?gh_src=abc", externalId: "555" },
    ]);
    const { unseen, known } = await keepUnseen([
      cand("PwC", "IN_Specialist 3_KYC/AML", "https://pwc.example/jobs/9001/", "9001"),
      cand("Ramp", "Software Engineer, Backend, Comms Platform", "https://boards.greenhouse.io/ramp/jobs/555", "555"),
      cand("Ramp", "Staff Engineer, Payments", "https://boards.greenhouse.io/ramp/jobs/999", "999"),
    ]);
    expect(unseen.map((c) => c.title)).toEqual(["Staff Engineer, Payments"]);
    expect(known).toBe(2);
  });

  it("looks the refs up in one batch, not once per job", async () => {
    const many = Array.from({ length: 50 }, (_, i) => cand("Acme", `Role ${i}`, `https://acme.io/j/${i}`, String(i)));
    await keepUnseen(many);
    expect(findRefs).toHaveBeenCalledTimes(1);
    expect((findRefs.mock.calls[0]?.[0] as string[]).length).toBe(50);
  });
});
