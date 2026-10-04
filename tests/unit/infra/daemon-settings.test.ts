/**
 * What the VPS daemons leave in ~/.claude for the bot to read (src/infra/daemon-settings.ts).
 * Shared by /review (gateway) and the ops_state `background_jobs` scope (tools): nothing outside src/gateway may
 * import gateway (verify-architecture R1), so the file reading lives here and both call it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STALE_AFTER_MS,
  ago,
  daemonFile,
  effectiveFile,
  parseDown,
  readIfPresent,
  readReviewSetup,
  reviewOffFile,
} from "../../../src/infra/daemon-settings.js";

describe("daemon file paths", () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["HOME"];
    home = mkdtempSync(join(tmpdir(), "daemon-settings-"));
    process.env["HOME"] = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it("every file is <daemon>.<kind> under ~/.claude", () => {
    expect(daemonFile("pr-brain", "off")).toBe(join(home, ".claude", "pr-brain.off"));
    expect(daemonFile("agent-dispatch", "down")).toBe(join(home, ".claude", "agent-dispatch.down"));
    expect(effectiveFile("agent-dispatch")).toBe(join(home, ".claude", "agent-dispatch.effective"));
    expect(reviewOffFile()).toBe(daemonFile("pr-brain", "off"));
  });

  it("readIfPresent: text when there, null when missing, a thrown error when it cannot be read", () => {
    const file = join(home, "x");
    expect(readIfPresent(file)).toBeNull();
    writeFileSync(file, "hello\n");
    expect(readIfPresent(file)).toBe("hello\n");
    mkdirSync(join(home, "adir"));
    expect(() => readIfPresent(join(home, "adir"))).toThrow(/EISDIR/);
  });
});

describe("parseDown", () => {
  it("line 1 is the class, line 2 the UTC time it went down (deploy/lib/down-state.sh)", () => {
    expect(parseDown("limit\n2026-10-04 12:10 UTC\nextra\n")).toEqual({ cls: "limit", since: "2026-10-04 12:10 UTC" });
  });

  it("an empty or one-line file still says it is down", () => {
    expect(parseDown("")).toEqual({ cls: "", since: "" });
    expect(parseDown("auth\n")).toEqual({ cls: "auth", since: "" });
  });
});

describe("ago", () => {
  it("is hours up to two days, then days", () => {
    expect(ago(5 * 3_600_000)).toBe("5 h ago");
    expect(ago(47 * 3_600_000)).toBe("47 h ago");
    expect(ago(72 * 3_600_000)).toBe("3 days ago");
  });

  it("a report is stale after two hours: the 20-minute cron missed six runs", () => {
    expect(STALE_AFTER_MS).toBe(2 * 3_600_000);
  });
});

describe("readReviewSetup", () => {
  it("reads reviewers, merge setting and writer models from the two reports", () => {
    const setup = readReviewSetup(
      "written=1790000000\nengine=agy\nreviewers=model-a model-b\nmerge=0\n",
      "written=1790000100\nagy_model=gemini-x\nclaude_model=sonnet\n",
    );
    expect(setup.reviewers).toEqual(["model-a", "model-b"]);
    expect(setup.merges).toBe(false);
    expect(setup.agyModel).toBe("gemini-x");
    expect(setup.claudeModel).toBe("sonnet");
    expect(setup.reviewerReportedAt).toBe(1790000000_000);
    expect(setup.writerReportedAt).toBe(1790000100_000);
  });

  it("a daemon that has not reported leaves everything null", () => {
    expect(readReviewSetup(null, null)).toEqual({
      reviewers: null,
      merges: null,
      agyModel: null,
      claudeModel: null,
      reviewerReportedAt: null,
      writerReportedAt: null,
    });
  });
});
