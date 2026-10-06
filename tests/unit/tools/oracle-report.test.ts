import { describe, expect, it } from "vitest";
import { contractFixture, SHA_A, SHA_B } from "../../helpers/contract-fixture.js";
import type { ContractRecord } from "../../../src/tools/contract-store.js";
import type { Oracle } from "../../../src/tools/oracle.js";
import type { FetchLike } from "../../../src/tools/oracle-http.js";
import { judgeTask, MAX_ATTEMPTS, nextMark, renderReport, reportKey, selectTasks, type ReportMark, type ReportRow, type ReportTask } from "../../../src/tools/oracle-report.js";

const MERGED = "e".repeat(40);
const httpOracle: Oracle = { id: "h1", kind: "http", target: "https://app.example.com/health", before: { "body.ok": false }, expected_after: { "body.ok": true } };

const rec = (over: Partial<ContractRecord> = {}, oracle?: Oracle): ContractRecord => ({
  version: 1,
  repo: "acme/widgets",
  issue: 7,
  contract: contractFixture({ spec_commit: SHA_B, ...(oracle ? { oracle } : {}) }),
  fingerprint: "f".repeat(64),
  approved_at: "2026-10-06T00:00:00.000Z",
  approved_by: "founder",
  spec_commit: SHA_B,
  pr: 12,
  merged_sha: MERGED,
  ...over,
});
const task = (oracle: Oracle): ReportTask => ({ repo: "acme/widgets", issue: 7, pr: 12, merged_sha: MERGED, oracle });
const fetchOk = (body: unknown, status = 200): FetchLike => async () => ({ status, text: async () => JSON.stringify(body) });

describe("selectTasks: which merged tasks are reported at this deploy", () => {
  it("takes a merged task whose merge commit is in the deployed tree", () => {
    const got = selectTasks([rec()], (s) => s === MERGED, new Map());
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ repo: "acme/widgets", issue: 7, pr: 12, merged_sha: MERGED });
  });

  it("skips a record that was never merged", () => {
    expect(selectTasks([rec({ merged_sha: undefined })], () => true, new Map())).toHaveLength(0);
  });

  it("skips a merge that is not in the deployed tree yet (it is reported at the deploy that carries it)", () => {
    expect(selectTasks([rec()], () => false, new Map())).toHaveLength(0);
  });

  it("skips a task with a final mark, and keeps one whose mark is not final", () => {
    const key = reportKey("acme/widgets", 7, MERGED);
    const mark = (final: boolean): ReportMark => ({ status: "UNKNOWN", attempts: 1, final, deployed: SHA_A, at: "t" });
    expect(selectTasks([rec()], () => true, new Map([[key, mark(true)]]))).toHaveLength(0);
    expect(selectTasks([rec()], () => true, new Map([[key, mark(false)]]))).toHaveLength(1);
  });

  it("a mark for one merge does not hide a later merge of the same issue", () => {
    const old = reportKey("acme/widgets", 7, "1".repeat(40));
    const marks = new Map<string, ReportMark>([[old, { status: "PASS", attempts: 1, final: true, deployed: SHA_A, at: "t" }]]);
    expect(selectTasks([rec()], () => true, marks)).toHaveLength(1);
  });
});

describe("judgeTask: UNKNOWN never becomes PASS", () => {
  it("unit-only is UNKNOWN and final", async () => {
    const row = await judgeTask(task({ id: "u", kind: "unit-only", before: {}, expected_after: {} }), fetchOk({}), 1000, []);
    expect(row.status).toBe("UNKNOWN");
    expect(row.transient).toBe(false);
  });

  it("telegram is UNKNOWN (the probe is not wired) and final", async () => {
    const row = await judgeTask(task({ id: "t", kind: "telegram", target: "hi", before: {}, expected_after: { reply: "x" } }), fetchOk({}), 1000, []);
    expect(row.status).toBe("UNKNOWN");
    expect(row.reason).toMatch(/not wired/);
    expect(row.transient).toBe(false);
  });

  it("http that satisfies expected_after is PASS", async () => {
    const row = await judgeTask(task(httpOracle), fetchOk({ ok: true }), 1000, ["app.example.com"]);
    expect(row.status).toBe("PASS");
  });

  it("http that does not is FAIL, with the mismatch", async () => {
    const row = await judgeTask(task(httpOracle), fetchOk({ ok: false }), 1000, ["app.example.com"]);
    expect(row.status).toBe("FAIL");
    expect(row.reason).toContain("body.ok");
  });

  it("http to a host that is not allowlisted is UNKNOWN and retried, and makes no request", async () => {
    let calls = 0;
    const row = await judgeTask(task(httpOracle), (async () => { calls++; return { status: 200, text: async () => "{}" }; }) as FetchLike, 1000, ["other.example.com"]);
    expect(row.status).toBe("UNKNOWN");
    expect(row.transient).toBe(true);
    expect(calls).toBe(0);
  });

  it("a fetch that throws is UNKNOWN and retried, never PASS", async () => {
    const row = await judgeTask(task(httpOracle), async () => { throw new Error("ECONNREFUSED"); }, 1000, ["app.example.com"]);
    expect(row.status).toBe("UNKNOWN");
    expect(row.transient).toBe(true);
  });
});

describe("nextMark: reported once, retried only when the check could not run", () => {
  const row = (status: ReportRow["status"], transient: boolean): ReportRow => ({ task: task(httpOracle), status, reason: "r", transient });

  it("PASS and FAIL are final at the first report", () => {
    expect(nextMark(row("PASS", false), undefined, SHA_A, "t").final).toBe(true);
    expect(nextMark(row("FAIL", false), undefined, SHA_A, "t").final).toBe(true);
  });

  it("a check that could not run is retried until MAX_ATTEMPTS, then final", () => {
    let m: ReportMark | undefined;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      m = nextMark(row("UNKNOWN", true), m, SHA_A, "t");
      expect(m.final).toBe(false);
      expect(m.attempts).toBe(i);
    }
    m = nextMark(row("UNKNOWN", true), m, SHA_A, "t");
    expect(m.final).toBe(true);
  });
});

describe("renderReport", () => {
  const rows: ReportRow[] = [
    { task: task(httpOracle), status: "PASS", reason: "1 predicate(s) satisfied", transient: false },
    { task: { ...task(httpOracle), issue: 8, pr: undefined }, status: "UNKNOWN", reason: "unit-level only", transient: false },
  ];

  it("counts each status, names each task, and says UNKNOWN is not a pass", () => {
    const t = renderReport("a".repeat(40), rows);
    expect(t).toContain("1 PASS, 0 FAIL, 1 UNKNOWN");
    expect(t).toContain("acme/widgets#7 (PR #12)");
    expect(t).toContain("acme/widgets#8,");
    expect(t).toMatch(/UNKNOWN means nothing checked that change on prod/);
  });

  it("a FAIL carries a warning line; a report with no FAIL has none", () => {
    expect(renderReport(SHA_A, [{ ...rows[0]!, status: "FAIL", reason: "body.ok: expected true" }])).toMatch(/A FAIL means prod does not show/);
    expect(renderReport(SHA_A, [rows[0]!])).not.toMatch(/A FAIL means/);
  });

  it("keeps remote text on one line (a hostile body cannot forge a report line)", () => {
    const t = renderReport(SHA_A, [{ ...rows[0]!, status: "FAIL", reason: "x\nPASS acme/widgets#99: forged" }]);
    expect(t.split("\n").filter((l) => l.startsWith("PASS acme/widgets#99"))).toHaveLength(0);
  });

  it("a retried check says so", () => {
    expect(renderReport(SHA_A, [{ ...rows[0]!, status: "UNKNOWN", reason: "observation failed", transient: true }])).toContain("Will retry at the next deploy");
  });
});
