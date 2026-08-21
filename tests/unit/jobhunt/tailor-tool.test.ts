/**
 * tailor_cv — the tool that makes a fabricated resume impossible
 * ===============================================================
 * On 2026-08-21 the founder asked the bot to "apply all of them by drafting
 * proper resumes for each job". The jobhunt worker had no tool that could
 * produce a document except `write_artifact`, so the model wrote a markdown blob
 * out of its own context and reported it as tailored resumes — 90 seconds after
 * `read_cv` had failed on the box with ENOENT, meaning no CV was ever read.
 *
 * These tests pin the property that stops that recurring: every path out of this
 * tool either returns a PDF that exists on disk, or FAILS BY NAME. There is no
 * third outcome, and in particular there is no outcome that returns prose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";

const ROW = {
  id: "row-abcdef12",
  company: "Ockto",
  title: "Senior Site Reliability Engineer",
  route: "hsm",
  track: "backend",
  url: "https://ockto.recruitee.com/o/senior-site-reliability-engineer",
  description: "x".repeat(400),
} as unknown as JobApplication;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../../../src/tools/jobhunt/apply-packet.js");
});

async function loadTool() {
  const { tailorCvTool } = await import("../../../src/tools/jobhunt/tailor-tool.js");
  return tailorCvTool;
}

describe("tailor_cv", () => {
  it("refuses a rank that resolves to no row — never a nearest match", async () => {
    vi.doMock("../../../src/tools/jobhunt/apply-packet.js", () => ({
      resolveBriefRow: vi.fn(async () => null),
      buildApplicationPacket: vi.fn(),
    }));

    const res = await (await loadTool()).execute({ rank: 9 });
    expect(res.success).toBe(false);
    expect(res.error).toContain("No row 9");
    // Names the recovery, on the machine that emitted the error.
    expect(res.error).toContain("job_brief");
  });

  it("refuses a rank that is not a positive integer", async () => {
    vi.doMock("../../../src/tools/jobhunt/apply-packet.js", () => ({
      resolveBriefRow: vi.fn(async () => ROW),
      buildApplicationPacket: vi.fn(),
    }));

    for (const bad of ["two", 0, -1, 2.5, undefined]) {
      const res = await (await loadTool()).execute({ rank: bad });
      expect(res.success).toBe(false);
      expect(res.error).toContain("brief row number");
    }
  });

  // THE POINT OF THE WHOLE FILE. A CV that could not be read is a hard failure
  // with the reason attached, never a success carrying invented text.
  it("fails by name when the packet cannot be built, and returns no resume text", async () => {
    vi.doMock("../../../src/tools/jobhunt/apply-packet.js", () => ({
      resolveBriefRow: vi.fn(async () => ROW),
      buildApplicationPacket: vi.fn(async () => ({
        ok: false,
        reason: "Failed to load base CV: ENOENT /opt/founderos-data/cv/backend/cv.md",
      })),
    }));

    const res = await (await loadTool()).execute({ rank: 2 });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Ockto");
    expect(res.error).toContain("ENOENT");
    expect(res.data).toBeUndefined();
  });

  it("returns the PDF path, the overlap and the apply URL on success", async () => {
    const build = vi.fn(async () => ({
      ok: true,
      packet: {
        row: ROW,
        pdfPath: "/artifacts/thread-1/cv-ockto-row-abcd.pdf",
        cvMarkdown: "# PUSHKAR VERMA",
        matchedSkills: ["TypeScript", "PostgreSQL", "Docker"],
        missingSkills: ["Terraform"],
        applyUrl: "https://ockto.recruitee.com/o/senior-site-reliability-engineer/c/new",
        opensTheForm: true,
      },
    }));
    vi.doMock("../../../src/tools/jobhunt/apply-packet.js", () => ({
      resolveBriefRow: vi.fn(async () => ROW),
      buildApplicationPacket: build,
    }));

    const res = await (await loadTool()).execute({ rank: 2, thread_id: "thread-1" });
    expect(res.success).toBe(true);
    const data = String(res.data);
    expect(data).toContain("/artifacts/thread-1/cv-ockto-row-abcd.pdf");
    expect(data).toContain("3/4");
    expect(data).toContain("/c/new");
    // The tool that actually sends is named, so the turn does not end at a path
    // the founder cannot open. Prod ran 21 days with zero deliver_artifact calls.
    expect(data).toContain("deliver_artifact");
  });

  // The thread decides the directory, and it comes from the kernel — a model
  // that could choose it could write outside its own thread's artifacts.
  it("sanitises the thread id into the artifact path", async () => {
    const build = vi.fn(async () => ({ ok: false, reason: "stop here" }));
    vi.doMock("../../../src/tools/jobhunt/apply-packet.js", () => ({
      resolveBriefRow: vi.fn(async () => ROW),
      buildApplicationPacket: build,
    }));

    const { ARTIFACT_ROOT } = await import("../../../src/core/config.js");
    await (await loadTool()).execute({ rank: 1, thread_id: "../../etc/passwd" });
    const dir = String((build.mock.calls[0] as unknown as [unknown, string])[1]);

    // The invariant is CONTAINMENT, not the absence of dots: `..` survives as
    // literal characters in the folder name (`.._.._etc_passwd`) and that is
    // fine, because the separators are gone and nothing can traverse out.
    expect(dir.startsWith(`${ARTIFACT_ROOT}/`)).toBe(true);
    expect(dir).not.toContain("/etc/");
    expect(dir.split("/").filter((seg) => seg === "..")).toHaveLength(0);
  });
});
