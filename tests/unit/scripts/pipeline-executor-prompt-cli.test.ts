import { describe, expect, it } from "vitest";
import { runExecutorPrompt } from "../../../scripts/pipeline-executor-prompt.js";
import { writeContractRecord, type ContractRecord } from "../../../src/tools/contract-store.js";
import { contractFixture, SHA_B } from "../../helpers/contract-fixture.js";
import { memFs } from "../../helpers/mem-fs.js";

const ON = { AGENT_PIPELINE_V2: "1", FOUNDEROS_CONTRACTS_DIR: "/c" };
const REPO = "acme/widgets";
const record = (over: Partial<ContractRecord> = {}, contractOver = {}): ContractRecord => ({
  version: 1,
  repo: REPO,
  issue: 7,
  contract: contractFixture({ spec_commit: SHA_B, ...contractOver }),
  fingerprint: "f".repeat(64),
  approved_at: "2026-10-06T00:00:00.000Z",
  approved_by: "founder",
  spec_commit: SHA_B,
  ...over,
});
const stored = async (r: ContractRecord) => {
  const fs = memFs();
  const w = await writeContractRecord(fs, "/c", r);
  if (!w.ok) throw new Error(w.error);
  return fs;
};
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("scripts/pipeline-executor-prompt", () => {
  it("flag off: DISABLED, and the store is not read", async () => {
    const fs = memFs();
    let reads = 0;
    const spy = { ...fs, readFile: async (p: string) => { reads++; return fs.readFile(p); } };
    for (const sub of ["lookup", "build"]) {
      expect(parse(await runExecutorPrompt(sub, [REPO, "7", "task/issue-7", "beta"], "", {}, spy))).toEqual({ status: "DISABLED" });
      expect(parse(await runExecutorPrompt(sub, [REPO, "7", "task/issue-7", "beta"], "", { AGENT_PIPELINE_V2: "true" }, spy))).toEqual({ status: "DISABLED" });
    }
    expect(reads).toBe(0);
  });

  it("lookup: NONE when nothing was ever approved for the issue", async () => {
    expect(parse(await runExecutorPrompt("lookup", [REPO, "7"], "", ON, memFs()))).toEqual({ status: "NONE" });
  });

  it("lookup: CONTRACT with the spec commit when one is stored", async () => {
    const fs = await stored(record());
    expect(parse(await runExecutorPrompt("lookup", [REPO, "7"], "", ON, fs))).toEqual({ status: "CONTRACT", spec_commit: SHA_B });
  });

  it("lookup: a record with no spec commit anywhere is INVALID, never CONTRACT", async () => {
    const r = record({ spec_commit: undefined }, { spec_commit: undefined });
    const fs = await stored(r);
    const out = parse(await runExecutorPrompt("lookup", [REPO, "7"], "", ON, fs));
    expect(out.status).toBe("INVALID");
    expect(String(out.error)).toMatch(/spec_commit/);
  });

  it("lookup: a corrupt file is INVALID (fail closed), not NONE", async () => {
    const fs = memFs();
    fs.files.set("/c/acme__widgets__7.json", "{not json");
    const out = parse(await runExecutorPrompt("lookup", [REPO, "7"], "", ON, fs));
    expect(out.status).toBe("INVALID");
  });

  it("lookup: an unreadable store is INVALID, not NONE", async () => {
    const fs = memFs();
    const broken = { ...fs, readFile: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } };
    expect(parse(await runExecutorPrompt("lookup", [REPO, "7"], "", ON, broken)).status).toBe("INVALID");
  });

  it("lookup: bad arguments are INVALID", async () => {
    expect(parse(await runExecutorPrompt("lookup", [REPO, "x"], "", ON, memFs())).status).toBe("INVALID");
    expect(parse(await runExecutorPrompt("lookup", ["../etc", "7"], "", ON, memFs())).status).toBe("INVALID");
    expect(parse(await runExecutorPrompt("bogus", [REPO, "7"], "", ON, memFs())).status).toBe("INVALID");
  });

  it("build: PROMPT with the ask, the branch and the standards that were piped in", async () => {
    const fs = await stored(record({}, { ask: "make it stable" }));
    const std = "# S\n\n## 1. Hard gates\n\nno file over 400 lines\n\n## 9. Tests\n\nwrite the test first\n";
    const out = parse(await runExecutorPrompt("build", [REPO, "7", "task/issue-7", "beta"], std, ON, fs));
    expect(out.status).toBe("PROMPT");
    const p = String(out.prompt);
    expect(p).toContain("make it stable");
    expect(p).toContain("task/issue-7");
    expect(p).toContain("no file over 400 lines");
  });

  it("build: with no standards on stdin it still builds", async () => {
    const fs = await stored(record());
    const out = parse(await runExecutorPrompt("build", [REPO, "7", "task/issue-7", "beta"], "  \n", ON, fs));
    expect(out.status).toBe("PROMPT");
  });

  it("build: a missing contract is INVALID (the dispatcher decides legacy vs refuse with lookup first)", async () => {
    expect(parse(await runExecutorPrompt("build", [REPO, "7", "task/issue-7", "beta"], "", ON, memFs())).status).toBe("INVALID");
  });

  it("build: a bad branch is INVALID", async () => {
    const fs = await stored(record());
    expect(parse(await runExecutorPrompt("build", [REPO, "7", "task/issue-7; x", "beta"], "", ON, fs)).status).toBe("INVALID");
    expect(parse(await runExecutorPrompt("build", [REPO, "7"], "", ON, fs)).status).toBe("INVALID");
  });
});
