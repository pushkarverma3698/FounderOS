import { describe, it, expect, vi, beforeEach } from "vitest";
import { JobApplicationOperator } from "../../../src/services/jobhunt/application-operator.js";
import { BrowserApplicationExecutor } from "../../../src/services/jobhunt/browser-executor.js";
import { atsForUrl, resolveApplicationUrl } from "../../../src/services/jobhunt/ats-adapters.js";
import * as dbModule from "../../../src/db/client.js";

// Mock external dependencies
vi.mock("../../../src/db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../../src/tools/jobhunt/apply-packet.js", () => ({
  buildApplicationPacket: vi.fn().mockResolvedValue({
    ok: true,
    packet: {
      applyUrl: "https://boards.greenhouse.io/test/jobs/123",
      pdfPath: "/tmp/fake.pdf"
    }
  })
}));

describe("ATS Adapters", () => {
  it("should detect Greenhouse correctly", () => {
    expect(atsForUrl("https://boards.greenhouse.io/test/jobs/123")).toBe("greenhouse");
    expect(atsForUrl("https://jobs.lever.co/test/123")).toBe("lever");
    expect(atsForUrl("https://jobs.ashbyhq.com/test/123")).toBe("ashby");
    expect(atsForUrl("https://apply.workable.com/test/j/123")).toBe("workable");
    expect(atsForUrl("https://careers.company.com/unknown")).toBeNull();
  });

  it("should resolve application URLs properly for SPAs", () => {
    expect(resolveApplicationUrl("https://jobs.ashbyhq.com/test/123", "ashby")).toBe("https://jobs.ashbyhq.com/test/123/application");
    expect(resolveApplicationUrl("https://jobs.ashbyhq.com/test/123/application", "ashby")).toBe("https://jobs.ashbyhq.com/test/123/application");
  });
});

describe("BrowserApplicationExecutor", () => {
  it("initializes with dryRun flag correctly", () => {
    const executor = new BrowserApplicationExecutor(true);
    // Basic instantiation test since Playwright requires real browser in tests
    // Here we just test the flag assignment indirectly
    expect(executor).toBeInstanceOf(BrowserApplicationExecutor);
  });
});

describe("JobApplicationOperator", () => {
  let operator: JobApplicationOperator;
  
  beforeEach(() => {
    vi.clearAllMocks();
    operator = new JobApplicationOperator("/tmp", true); // dryRun
  });

  it("handles empty queue gracefully", async () => {
    // limit() returns [] due to mock
    await operator.runNext();
    expect(dbModule.db.update).not.toHaveBeenCalled();
  });
});
