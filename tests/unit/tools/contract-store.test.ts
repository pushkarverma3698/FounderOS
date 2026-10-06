import { describe, it, expect } from "vitest";
import {
  ContractRecordSchema,
  DEFAULT_CONTRACTS_DIR,
  contractFileName,
  contractsDir,
  readContractRecord,
  writeContractRecord,
  type ContractRecord,
} from "../../../src/tools/contract-store.js";
import { SHA_A, SHA_B, contractFixture } from "../../helpers/contract-fixture.js";
import { memFs } from "../../helpers/mem-fs.js";

const FP1 = "1".repeat(64);
const FP2 = "2".repeat(64);


function record(over: Partial<ContractRecord> = {}): ContractRecord {
  return {
    version: 1,
    repo: "acme/widgets",
    issue: 12,
    contract: contractFixture(),
    fingerprint: FP1,
    approved_at: "2026-10-05T10:00:00.000Z",
    approved_by: "founder",
    ...over,
  };
}


const DIR = "/store";
const ID = () => "t1";

describe("contractsDir / contractFileName", () => {
  it("uses FOUNDEROS_CONTRACTS_DIR, else the default", () => {
    expect(contractsDir({ FOUNDEROS_CONTRACTS_DIR: "/x/y" })).toBe("/x/y");
    expect(contractsDir({})).toBe(DEFAULT_CONTRACTS_DIR);
    expect(contractsDir({ FOUNDEROS_CONTRACTS_DIR: "  " })).toBe(DEFAULT_CONTRACTS_DIR);
    expect(DEFAULT_CONTRACTS_DIR).toBe("/var/lib/founderos/contracts");
  });
  it("names the file owner__name__issue.json", () => {
    expect(contractFileName("a/b", 12)).toEqual({ ok: true, value: "a__b__12.json" });
  });
  it("refuses a repo or issue that could escape the directory", () => {
    for (const repo of ["a/b/c", "../x", "a b/c", "a/", "", "a"]) {
      expect(contractFileName(repo, 1).ok, repo).toBe(false);
    }
    for (const issue of [0, -1, 1.5, Number.NaN]) {
      expect(contractFileName("a/b", issue).ok, String(issue)).toBe(false);
    }
  });
});

describe("writeContractRecord + readContractRecord", () => {
  it("round-trips a record", async () => {
    const fs = memFs();
    const w = await writeContractRecord(fs, DIR, record(), ID);
    expect(w.ok).toBe(true);
    const r = await readContractRecord(fs, DIR, "acme/widgets", 12);
    expect(r).toEqual({ ok: true, value: record() });
    expect([...fs.files.keys()]).toEqual(["/store/acme__widgets__12.json"]);
  });
  it("writes a tmp file then renames: no tmp file is left behind", async () => {
    const fs = memFs();
    await writeContractRecord(fs, DIR, record(), ID);
    expect(fs.renames).toBe(1);
    expect([...fs.files.keys()].some((k) => k.endsWith(".tmp"))).toBe(false);
  });
  it("cleans the tmp file and returns an io error when the rename fails", async () => {
    const fs = memFs({ failRename: true });
    const w = await writeContractRecord(fs, DIR, record(), ID);
    expect(w).toMatchObject({ ok: false, code: "io" });
    expect(fs.files.size).toBe(0);
  });
  it("REFUSES to overwrite a record with a different fingerprint", async () => {
    const fs = memFs();
    await writeContractRecord(fs, DIR, record(), ID);
    const before = fs.files.get("/store/acme__widgets__12.json");
    const w = await writeContractRecord(fs, DIR, record({ fingerprint: FP2 }), ID);
    expect(w).toMatchObject({ ok: false, code: "conflict" });
    expect(fs.files.get("/store/acme__widgets__12.json")).toBe(before);
  });
  it("allows the same fingerprint to fill in spec_commit, pr and merged_sha", async () => {
    const fs = memFs();
    await writeContractRecord(fs, DIR, record(), ID);
    const w1 = await writeContractRecord(fs, DIR, record({ spec_commit: SHA_B, pr: 40 }), ID);
    expect(w1.ok).toBe(true);
    const w2 = await writeContractRecord(fs, DIR, record({ spec_commit: SHA_B, pr: 40, merged_sha: SHA_A }), ID);
    expect(w2.ok).toBe(true);
    const r = await readContractRecord(fs, DIR, "acme/widgets", 12);
    expect(r.ok && r.value).toMatchObject({ spec_commit: SHA_B, pr: 40, merged_sha: SHA_A });
  });
  it("refuses to change spec_commit, pr or merged_sha once set", async () => {
    const fs = memFs();
    await writeContractRecord(fs, DIR, record({ spec_commit: SHA_B, pr: 40 }), ID);
    expect(await writeContractRecord(fs, DIR, record({ spec_commit: SHA_A, pr: 40 }), ID)).toMatchObject({ ok: false, code: "conflict" });
    expect(await writeContractRecord(fs, DIR, record({ spec_commit: SHA_B, pr: 41 }), ID)).toMatchObject({ ok: false, code: "conflict" });
    expect(await writeContractRecord(fs, DIR, record({ pr: 40 }), ID)).toMatchObject({ ok: false, code: "conflict" });
  });
  it("refuses a same-fingerprint write that loosens the contract (limits, risk, oracle)", async () => {
    const fs = memFs();
    await writeContractRecord(fs, DIR, record(), ID);
    const loose = contractFixture({ limits: { files: 500, lines: 99999, deleted_lines: 99999, new_dependencies: false }, risk: "low" });
    expect(await writeContractRecord(fs, DIR, record({ contract: loose }), ID)).toMatchObject({ ok: false, code: "conflict" });
    expect(await writeContractRecord(fs, DIR, record({ approved_by: "auto" }), ID)).toMatchObject({ ok: false, code: "conflict" });
  });
  it("does not clobber a corrupt existing file", async () => {
    const fs = memFs();
    fs.files.set("/store/acme__widgets__12.json", "{not json");
    const w = await writeContractRecord(fs, DIR, record(), ID);
    expect(w).toMatchObject({ ok: false, code: "invalid" });
    expect(fs.files.get("/store/acme__widgets__12.json")).toBe("{not json");
  });
  it("refuses a record whose contract is invalid or whose repo does not match", async () => {
    const fs = memFs();
    const bad = { ...record(), contract: { ...contractFixture(), locked_tests: [] } } as unknown as ContractRecord;
    expect(await writeContractRecord(fs, DIR, bad, ID)).toMatchObject({ ok: false, code: "invalid" });
    const mismatch = record({ contract: contractFixture({ repo: "other/repo" }) });
    expect(await writeContractRecord(fs, DIR, mismatch, ID)).toMatchObject({ ok: false, code: "invalid" });
    expect(await writeContractRecord(fs, DIR, record({ fingerprint: "nothex" }), ID)).toMatchObject({ ok: false, code: "invalid" });
    expect(fs.files.size).toBe(0);
  });
  it("returns not_found for a missing task, never a throw", async () => {
    expect(await readContractRecord(memFs(), DIR, "acme/widgets", 99)).toMatchObject({ ok: false, code: "not_found" });
  });
  it("returns an error value, not a partial contract, for an invalid or tampered file", async () => {
    const fs = memFs();
    const key = "/store/acme__widgets__12.json";
    fs.files.set(key, "{not json");
    expect(await readContractRecord(fs, DIR, "acme/widgets", 12)).toMatchObject({ ok: false, code: "invalid" });
    const noTests = { ...record(), contract: { ...contractFixture(), locked_tests: [] } };
    fs.files.set(key, JSON.stringify(noTests));
    expect(await readContractRecord(fs, DIR, "acme/widgets", 12)).toMatchObject({ ok: false, code: "invalid" });
    fs.files.set(key, JSON.stringify(record({ issue: 13 })));
    const moved = await readContractRecord(fs, DIR, "acme/widgets", 12);
    expect(moved).toMatchObject({ ok: false, code: "invalid" });
    fs.files.set(key, JSON.stringify({ ...record(), extra: 1 }));
    expect(await readContractRecord(fs, DIR, "acme/widgets", 12)).toMatchObject({ ok: false, code: "invalid" });
  });
  it("reports a non-ENOENT read failure as io", async () => {
    const fs = memFs();
    fs.readFile = async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(await readContractRecord(fs, DIR, "acme/widgets", 12)).toMatchObject({ ok: false, code: "io" });
  });
  it("schema rejects an approved_by other than founder or auto", () => {
    expect(ContractRecordSchema.safeParse({ ...record(), approved_by: "bot" }).success).toBe(false);
  });
});
