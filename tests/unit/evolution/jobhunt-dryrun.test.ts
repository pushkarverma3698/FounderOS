/**
 * Unit tests — the read-only dry run of the daily check.
 * =======================================================
 * `scripts/jobhunt-findings-check.ts` prints what the 09:30 check would say now. It
 * exists so the founder can see the line before the first scheduled morning, and its
 * one hard property is that it CANNOT act: it files nothing, sends nothing and
 * writes nothing, whatever the data says. That is also what keeps "at most one issue
 * a day" true: the only thing that files is the cron.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sendToChat = vi.fn(async () => {});
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat }));
const create = vi.fn(async () => ({ data: { number: 1, html_url: "https://x/1" } }));
const listForRepo = vi.fn(async () => ({ data: [] }));
vi.mock("octokit", () => ({ Octokit: vi.fn(() => ({ rest: { issues: { listForRepo, create } } })) }));

const { runDryRun } = await import("../../../scripts/jobhunt-findings-check.js");
const { withSilent, healthy, NOW } = await import("../../helpers/jobhunt-fixtures.js");

let dataRoot: string;
let lines: string[];

beforeEach(() => {
  vi.clearAllMocks();
  dataRoot = mkdtempSync(join(tmpdir(), "jobhunt-dry-"));
  process.env["FOUNDEROS_DATA_ROOT"] = dataRoot;
  process.env["HALT_FLAG_PATH"] = join(dataRoot, "HALT");
  process.env["GITHUB_TOKEN"] = "test-token-not-real";
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env["FOUNDEROS_DATA_ROOT"];
  delete process.env["HALT_FLAG_PATH"];
});

describe("dry run", () => {
  it("shows the finding it WOULD file, and files nothing, sends nothing, writes nothing", async () => {
    const code = await runDryRun({ now: () => NOW, read: async () => withSilent("ashby") });

    const out = lines.join("\n");
    expect(out).toContain("DRY RUN");
    expect(out).toContain("WOULD FILE");
    expect(out).toContain("adapter-silent: ashby");
    expect(create).not.toHaveBeenCalled();
    expect(sendToChat).not.toHaveBeenCalled();
    expect(readdirSync(dataRoot)).toEqual([]);
    expect(code).toBe(0);
  });

  it("does read GitHub's history when there is something to file, so 'would file' means would file after the dedupe", async () => {
    await runDryRun({ now: () => NOW, read: async () => withSilent("ashby") });
    expect(listForRepo).toHaveBeenCalledWith(expect.objectContaining({ state: "all", labels: "evolution:auto" }));
  });

  it("prints the Telegram message instead of sending it", async () => {
    await runDryRun({ now: () => NOW, read: async () => healthy() });
    expect(lines.join("\n")).toContain("Jobhunt check: nothing new");
  });

  it("exits non-zero when the check failed, so a script can tell", async () => {
    const code = await runDryRun({
      now: () => NOW,
      read: async () => {
        throw new Error("job_ingest_runs read failed: connect ECONNREFUSED");
      },
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("check failed");
  });
});
