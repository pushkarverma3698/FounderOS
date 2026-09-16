/**
 * read_logs — FounderOS reading its own production journal.
 *
 * THE BUG THIS EXISTS FOR (2026-09-15 19:35, production):
 * The founder asked "read founderOs logs and reason as many bugs as you can".
 * No tool could read a log line. Instead of reporting the missing instrument,
 * the planner substituted `project_workflow list_files` against
 * /opt/founderos/apps/jarvis — a path retired with v2 on 2026-07-08 — read zero
 * log lines, and emitted a confident "Log & Execution Records Audit Summary".
 * Those fabricated findings were then dispatched to an executor as issues
 * #677/#678.
 *
 * So the load-bearing property here is NOT "can it read logs". It is: a failure
 * to read logs must be IMPOSSIBLE to narrate as a clean result. An empty read
 * and a broken read must be distinguishable, loudly, in the tool result itself.
 */
import { describe, it, expect } from "vitest";
import {
  buildJournalArgs,
  filterLogLines,
  summarizeLogs,
  readLogs,
  LOG_UNIT_ALLOWLIST,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SCAN_CAP,
  type JournalRunner,
} from "../../../src/tools/read-logs.js";

const info = (msg: string, module = "kernel") =>
  JSON.stringify({ level: 30, time: "2026-09-16T10:00:00.000Z", module, msg });
const warn = (msg: string, module = "kernel") =>
  JSON.stringify({ level: 40, time: "2026-09-16T10:00:01.000Z", module, msg });
const error = (msg: string, module = "trace") =>
  JSON.stringify({ level: 50, time: "2026-09-16T10:00:02.000Z", module, msg });

const okRunner = (stdout: string): JournalRunner => async () => ({ stdout, stderr: "", code: 0 });

describe("buildJournalArgs", () => {
  it("defaults to the founderos unit and a one-hour window", () => {
    const args = buildJournalArgs({});

    expect(args).toContain("-u");
    expect(args).toContain("founderos.service");
    expect(args).toContain("--since");
    expect(args).toContain("1 hour ago");
    expect(args).toContain("--no-pager");
    expect(args).toContain("-n");
    expect(args).toContain(String(SCAN_CAP));
  });

  it("passes through an explicit window", () => {
    const args = buildJournalArgs({ since: "2026-09-15", until: "2026-09-16" });

    expect(args[args.indexOf("--since") + 1]).toBe("2026-09-15");
    expect(args[args.indexOf("--until") + 1]).toBe("2026-09-16");
  });

  /**
   * REGRESSION (found 2026-09-16 by running the tool against the real journal;
   * the mocked tests could not see it). `-n` is applied by journalctl BEFORE any
   * grep/level filter runs here. Passing the caller's small `limit` as `-n` meant
   * journalctl returned only the last N lines — in prod, N composio upgrade-nag
   * lines — and the level filter then found no errors in them and reported
   * "the read SUCCEEDED and the window is genuinely empty" while real errors sat
   * just outside the tail. A confident false negative: the exact failure mode
   * this tool exists to remove.
   *
   * So `-n` is the SCAN cap (how much journal to examine); the caller's `limit`
   * caps what is RETURNED, applied after filtering.
   */
  it("sends journalctl the scan cap, never the caller's output limit", () => {
    const args = buildJournalArgs({ limit: 3 });

    expect(args[args.indexOf("-n") + 1]).toBe(String(SCAN_CAP));
  });

  it("uses the scan cap regardless of how large the output limit is", () => {
    const args = buildJournalArgs({ limit: 999_999 });

    expect(args[args.indexOf("-n") + 1]).toBe(String(SCAN_CAP));
  });

  it("refuses a unit outside the allowlist instead of shelling it out", () => {
    expect(() => buildJournalArgs({ unit: "sshd.service; rm -rf /" })).toThrow(/allowlist/i);
  });

  it("accepts every allowlisted unit", () => {
    for (const unit of LOG_UNIT_ALLOWLIST) {
      expect(() => buildJournalArgs({ unit })).not.toThrow();
    }
  });
});

describe("filterLogLines", () => {
  const lines = [
    info("Free ingest complete", "jobhunt:free-ingest"),
    warn("tool error", "trace"),
    error("turn.error", "trace"),
    "Sep 16 10:12:01 founder-os founderos[320360]: 🚀 Upgrade available! composio-core",
  ];

  it("level=error keeps only pino level 50 and above", () => {
    const out = filterLogLines(lines, { level: "error" });

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("turn.error");
  });

  it("level=warn keeps warnings and errors but not info", () => {
    const out = filterLogLines(lines, { level: "warn" });

    expect(out).toHaveLength(2);
  });

  it("drops unparseable lines when a level filter is active, since they carry no level", () => {
    const out = filterLogLines(lines, { level: "error" });

    expect(out.some((l) => l.includes("Upgrade available"))).toBe(false);
  });

  it("level=all keeps everything including non-JSON lines", () => {
    expect(filterLogLines(lines, { level: "all" })).toHaveLength(4);
  });

  it("greps case-insensitively across the raw line", () => {
    const out = filterLogLines(lines, { grep: "INGEST" });

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("free-ingest");
  });

  it("applies grep and level together", () => {
    const out = filterLogLines(lines, { level: "warn", grep: "turn.error" });

    expect(out).toHaveLength(1);
  });
});

describe("summarizeLogs", () => {
  it("counts by level and names the noisiest modules so the model need not re-read", () => {
    const summary = summarizeLogs([
      info("a", "jobhunt"),
      info("b", "jobhunt"),
      warn("c", "trace"),
      error("d", "trace"),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.errors).toBe(1);
    expect(summary.warnings).toBe(1);
    expect(summary.byModule["jobhunt"]).toBe(2);
  });
});

describe("readLogs — the anti-fabrication contract", () => {
  it("returns the matching lines on a clean read", async () => {
    const res = await readLogs({ level: "error" }, okRunner(error("turn.error")));

    expect(res.success).toBe(true);
    const data = res.data as { lines: string[] };
    expect(data.lines).toHaveLength(1);
  });

  it("FAILS LOUDLY when journalctl itself fails — never a clean empty result", async () => {
    const broken: JournalRunner = async () => ({
      stdout: "",
      stderr: "Failed to add match: Invalid argument",
      code: 1,
    });

    const res = await readLogs({}, broken);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid argument/);
  });

  it("reports a genuinely empty window as success but says so explicitly", async () => {
    const res = await readLogs({ grep: "nothing-matches-this" }, okRunner(""));

    expect(res.success).toBe(true);
    const data = res.data as { lines: string[]; note: string };
    expect(data.lines).toHaveLength(0);
    expect(data.note).toMatch(/no matching log lines/i);
  });

  it("distinguishes an empty window from a broken read in the payload itself", async () => {
    const empty = await readLogs({}, okRunner(""));
    const broken = await readLogs({}, async () => ({ stdout: "", stderr: "boom", code: 127 }));

    expect(empty.success).toBe(true);
    expect(broken.success).toBe(false);
  });

  it("surfaces a missing journalctl binary as an error, not as silence", async () => {
    const missing: JournalRunner = async () => {
      throw new Error("spawn journalctl ENOENT");
    };

    const res = await readLogs({}, missing);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ENOENT|journalctl/i);
  });

  it("redacts secret-shaped values before any log line reaches the model", async () => {
    const leaky = info("starting with GOOGLE_GENERATIVE_AI_API_KEY=AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7");

    const res = await readLogs({}, okRunner(leaky));

    expect(res.success).toBe(true);
    const data = res.data as { lines: string[] };
    expect(data.lines.join("\n")).not.toContain("AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7");
  });

  it("caps returned lines at the requested limit", async () => {
    const many = Array.from({ length: 50 }, (_, i) => info(`line ${i}`)).join("\n");

    const res = await readLogs({ limit: 10 }, okRunner(many));

    const data = res.data as { lines: string[] };
    expect(data.lines).toHaveLength(10);
  });

  it("caps at DEFAULT_LIMIT when no limit is given", async () => {
    const many = Array.from({ length: DEFAULT_LIMIT + 25 }, (_, i) => info(`line ${i}`)).join("\n");

    const res = await readLogs({}, okRunner(many));

    expect((res.data as { lines: string[] }).lines).toHaveLength(DEFAULT_LIMIT);
  });

  /** The regression above, end-to-end: a match outside the last `limit` lines must still be found. */
  it("finds a match that is NOT in the tail, because filtering precedes the output cap", async () => {
    const needleFirst = [
      error("the one real failure"),
      ...Array.from({ length: 40 }, (_, i) => info(`noise ${i}`)),
    ].join("\n");

    const res = await readLogs({ level: "error", limit: 5 }, okRunner(needleFirst));

    const data = res.data as { lines: string[] };
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0]).toContain("the one real failure");
  });

  it("warns that the scan ceiling was hit, so 'empty' is never confused with 'truncated'", async () => {
    const atCap = Array.from({ length: SCAN_CAP }, (_, i) => info(`line ${i}`)).join("\n");

    const res = await readLogs({ grep: "no-such-thing" }, okRunner(atCap));

    const data = res.data as { lines: string[]; note: string; truncated: boolean };
    expect(data.lines).toHaveLength(0);
    expect(data.truncated).toBe(true);
    expect(data.note).toMatch(/scan ceiling|truncat/i);
  });
});
