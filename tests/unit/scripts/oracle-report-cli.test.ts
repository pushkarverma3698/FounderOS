import { describe, expect, it } from "vitest";
import { memFs, type MemFs } from "../../helpers/mem-fs.js";
import { contractFixture, SHA_B } from "../../helpers/contract-fixture.js";
import type { ContractRecord } from "../../../src/tools/contract-store.js";
import type { FetchLike } from "../../../src/tools/oracle-http.js";
import { reportKey } from "../../../src/tools/oracle-report.js";
import { runOracleReport, type OracleReportDeps, type ReportFs } from "../../../scripts/oracle-report.js";

const DEPLOYED = "d".repeat(40);
const MERGED = "e".repeat(40);
const ENV = { AGENT_PIPELINE_V2: "1", FOUNDEROS_CONTRACTS_DIR: "/c", ORACLE_ALLOWED_HOSTS: "app.example.com" };
const httpOracle = { id: "h1", kind: "http" as const, target: "https://app.example.com/health", before: { "body.ok": false }, expected_after: { "body.ok": true } };

const record = (issue: number, over: Partial<ContractRecord> = {}, oracle?: typeof httpOracle): ContractRecord => ({
  version: 1,
  repo: "acme/widgets",
  issue,
  contract: contractFixture({ spec_commit: SHA_B, ...(oracle ? { oracle } : {}) }),
  fingerprint: "f".repeat(64),
  approved_at: "2026-10-06T00:00:00.000Z",
  approved_by: "founder",
  spec_commit: SHA_B,
  pr: 12,
  merged_sha: MERGED,
  ...over,
});

function reportFs(mem: MemFs): ReportFs {
  return {
    readFile: (p) => mem.readFile(p),
    writeFile: (p, d) => mem.writeFile(p, d),
    mkdir: (p, o) => mem.mkdir(p, o),
    async readdir(dir) {
      const names = new Set<string>();
      for (const k of mem.files.keys()) if (k.startsWith(dir + "/")) names.add(k.slice(dir.length + 1).split("/")[0]!);
      if (names.size === 0) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...names];
    },
  };
}

function put(mem: MemFs, r: ContractRecord): void {
  mem.files.set(`/c/${r.repo.replace("/", "__")}__${r.issue}.json`, JSON.stringify(r));
}

interface Rig { mem: MemFs; sent: { text: string; loud: boolean }[]; deps: OracleReportDeps; fetched: string[] }
function rig(opts: { sendOk?: boolean; body?: unknown; contains?: (s: string) => boolean; fetchThrows?: boolean } = {}): Rig {
  const mem = memFs();
  const sent: { text: string; loud: boolean }[] = [];
  const fetched: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    fetched.push(url);
    if (opts.fetchThrows) throw new Error("ECONNREFUSED");
    return { status: 200, text: async () => JSON.stringify(opts.body ?? { ok: true }) };
  };
  const deps: OracleReportDeps = {
    fs: reportFs(mem),
    contains: opts.contains ?? ((s) => s === MERGED),
    fetchImpl,
    async send(text, loud) { sent.push({ text, loud }); return opts.sendOk ?? true; },
    now: () => "2026-10-06T12:00:00.000Z",
  };
  return { mem, sent, deps, fetched };
}

const args = ["--deployed", DEPLOYED];
const last = (out: string): Record<string, unknown> => JSON.parse(out.split("\n").at(-1)!) as Record<string, unknown>;
const markFile = (issue: number): string => `/c/oracle-reports/${reportKey("acme/widgets", issue, MERGED)}.json`;

describe("oracle-report CLI", () => {
  it("flag off: DISABLED, nothing read, nothing sent", async () => {
    const r = rig();
    put(r.mem, record(7, {}, httpOracle));
    const out = await runOracleReport(args, { ...ENV, AGENT_PIPELINE_V2: "" }, r.deps);
    expect(last(out)).toEqual({ status: "DISABLED" });
    expect(r.sent).toHaveLength(0);
    expect(r.fetched).toHaveLength(0);
  });

  it("bad arguments are FAILED with the usage, and send nothing", async () => {
    const r = rig();
    for (const a of [[], ["--deployed"], ["--deployed", "main"], ["--deployed", DEPLOYED, "--x"], ["--deployed", DEPLOYED.toUpperCase()]]) {
      expect(last(await runOracleReport(a, ENV, r.deps)).status).toBe("FAILED");
    }
    expect(r.sent).toHaveLength(0);
  });

  it("nothing merged: OK, checked 0, no message", async () => {
    const r = rig();
    put(r.mem, record(7, { merged_sha: undefined }));
    expect(last(await runOracleReport(args, ENV, r.deps))).toEqual({ status: "OK", checked: 0, sent: false });
    expect(r.sent).toHaveLength(0);
  });

  it("no contracts directory at all: OK, checked 0", async () => {
    expect(last(await runOracleReport(args, ENV, rig().deps))).toEqual({ status: "OK", checked: 0, sent: false });
  });

  it("a merged http task that passes: one message, quiet, marked final", async () => {
    const r = rig();
    put(r.mem, record(7, {}, httpOracle));
    const out = await runOracleReport(args, ENV, r.deps);
    expect(last(out)).toMatchObject({ status: "OK", checked: 1, pass: 1, fail: 0, sent: true });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).toContain("1 PASS");
    expect(r.sent[0]!.loud).toBe(false);
    expect(JSON.parse(r.mem.files.get(markFile(7))!)).toMatchObject({ status: "PASS", attempts: 1, final: true, deployed: DEPLOYED });
  });

  it("a FAIL is sent loud, and the next deploy does not repeat it", async () => {
    const r = rig({ body: { ok: false } });
    put(r.mem, record(7, {}, httpOracle));
    await runOracleReport(args, ENV, r.deps);
    expect(r.sent[0]!.loud).toBe(true);
    expect(r.sent[0]!.text).toContain("FAIL acme/widgets#7");
    const again = await runOracleReport(args, ENV, r.deps);
    expect(last(again)).toEqual({ status: "OK", checked: 0, sent: false });
    expect(r.sent).toHaveLength(1);
  });

  it("a unit-only task is reported UNKNOWN with the warning, and is final", async () => {
    const r = rig();
    put(r.mem, record(7));
    await runOracleReport(args, ENV, r.deps);
    expect(r.sent[0]!.text).toContain("UNKNOWN acme/widgets#7");
    expect(r.sent[0]!.text).toContain("does not mean it works");
    expect(JSON.parse(r.mem.files.get(markFile(7))!).final).toBe(true);
    expect(r.fetched).toHaveLength(0);
  });

  it("a send that fails leaves NO mark, so the next deploy sends it again", async () => {
    const r = rig({ sendOk: false });
    put(r.mem, record(7, {}, httpOracle));
    expect(last(await runOracleReport(args, ENV, r.deps))).toMatchObject({ checked: 1, sent: false });
    expect(r.mem.files.has(markFile(7))).toBe(false);
    const ok = rig();
    ok.mem.files = r.mem.files;
    expect(last(await runOracleReport(args, ENV, { ...ok.deps, fs: reportFs(r.mem) }))).toMatchObject({ sent: true });
  });

  it("prod unreachable: UNKNOWN, retried at the next deploy, final at the third", async () => {
    const r = rig({ fetchThrows: true });
    put(r.mem, record(7, {}, httpOracle));
    for (let i = 1; i <= 3; i++) {
      expect(last(await runOracleReport(args, ENV, r.deps))).toMatchObject({ checked: 1 });
      expect(JSON.parse(r.mem.files.get(markFile(7))!)).toMatchObject({ attempts: i, final: i === 3 });
    }
    expect(last(await runOracleReport(args, ENV, r.deps))).toMatchObject({ checked: 0 });
  });

  it("a merge that is not in the deployed tree is left for the deploy that carries it", async () => {
    const r = rig({ contains: () => false });
    put(r.mem, record(7, {}, httpOracle));
    expect(last(await runOracleReport(args, ENV, r.deps))).toMatchObject({ checked: 0 });
    expect(r.fetched).toHaveLength(0);
  });

  it("one corrupt record does not hide the others", async () => {
    const r = rig();
    r.mem.files.set("/c/acme__widgets__3.json", "{not json");
    put(r.mem, record(7, {}, httpOracle));
    expect(last(await runOracleReport(args, ENV, r.deps))).toMatchObject({ checked: 1, pass: 1 });
  });

  it("one message covers several tasks", async () => {
    const r = rig();
    put(r.mem, record(7, {}, httpOracle));
    put(r.mem, record(8));
    expect(last(await runOracleReport(args, ENV, r.deps))).toMatchObject({ checked: 2 });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).toContain("2 merged task(s)");
  });

  it("a host that is not on the allowlist is never fetched", async () => {
    const r = rig();
    put(r.mem, record(7, {}, httpOracle));
    await runOracleReport(args, { ...ENV, ORACLE_ALLOWED_HOSTS: "" }, r.deps);
    expect(r.fetched).toHaveLength(0);
    expect(r.sent[0]!.text).toContain("UNKNOWN");
  });
});
