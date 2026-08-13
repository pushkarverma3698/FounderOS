/**
 * M0a — Evolution Engine v0: persist-findings unit tests.
 * ===========================================================
 * `../../../src/db/queries.js` is mocked with a small in-memory store that
 * mirrors the REAL query functions' contract exactly (upsert-by-fingerprint,
 * bump times_seen, flip resolved→regressed on reappearance, coverage-gated
 * resolution) — see src/db/queries.ts's evolution_findings section for the
 * SQL this fake stands in for. This proves persistFindingsForRun's
 * orchestration (dedup, counting, fail-open) end to end, $0, deterministic,
 * without a live Postgres — which this container does not have (see PR body).
 *
 * These are also this PR's required acceptance tests:
 *  - two runs, one unchanged finding → ONE row, times_seen=2
 *  - a resolved finding reappearing (its analyzer in coverage) → regressed
 *  - an analyzer excluded from a run → its prior findings stay untouched
 *  - the result the report would render includes recurrence + regression counts
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Finding } from "../../../src/evolution/types.js";

// ── In-memory fake mirroring src/db/queries.ts's evolution_* functions ────────

interface FakeRow {
  fingerprint: string;
  kind: string;
  subject: string;
  location: string | null;
  analyzer: string;
  times_seen: number;
  status: "open" | "resolved" | "regressed";
}

let store: Map<string, FakeRow>;
let runIdCounter: number;
const startedRuns: Array<{ tenant_id: string; loop: string; analyzers_run: string[] }> = [];
const finishedRuns: Array<{ runId: string; findings_count: number; outcome: string }> = [];

const startEvolutionRun = vi.fn(async (data: { tenant_id: string; commit_sha: string | null; loop: string; analyzers_run: string[] }) => {
  startedRuns.push({ tenant_id: data.tenant_id, loop: data.loop, analyzers_run: data.analyzers_run });
  return `run-${++runIdCounter}`;
});

const finishEvolutionRun = vi.fn(async (runId: string, data: { findings_count: number; outcome: string }) => {
  finishedRuns.push({ runId, ...data });
});

const getEvolutionFindingsByFingerprint = vi.fn(async (_tenantId: string, fingerprints: readonly string[]) => {
  return fingerprints
    .map((fp) => store.get(fp))
    .filter((r): r is FakeRow => r !== undefined)
    .map((r) => ({ fingerprint: r.fingerprint, status: r.status, times_seen: r.times_seen }));
});

const upsertEvolutionFinding = vi.fn(
  async (data: {
    tenant_id: string;
    fingerprint: string;
    kind: string;
    subject: string;
    severity: string;
    location: string | null;
    detail: string;
    analyzer: string;
    run_id: string;
  }) => {
    const existing = store.get(data.fingerprint);
    if (!existing) {
      store.set(data.fingerprint, {
        fingerprint: data.fingerprint,
        kind: data.kind,
        subject: data.subject,
        location: data.location,
        analyzer: data.analyzer,
        times_seen: 1,
        status: "open",
      });
      return;
    }
    // Mirrors the CASE expressions in upsertEvolutionFinding (queries.ts):
    // resolved -> regressed on reappearance, otherwise status is unchanged.
    existing.times_seen += 1;
    existing.analyzer = data.analyzer;
    existing.kind = data.kind;
    existing.subject = data.subject;
    existing.location = data.location;
    if (existing.status === "resolved") existing.status = "regressed";
  },
);

const resolveMissingEvolutionFindings = vi.fn(
  async (_tenantId: string, analyzer: string, currentFingerprints: readonly string[]) => {
    const current = new Set(currentFingerprints);
    const resolved: Array<{ fingerprint: string }> = [];
    for (const row of store.values()) {
      if (row.analyzer !== analyzer) continue;
      if (row.status !== "open" && row.status !== "regressed") continue;
      if (current.has(row.fingerprint)) continue;
      row.status = "resolved";
      resolved.push({ fingerprint: row.fingerprint });
    }
    return resolved;
  },
);

vi.mock("../../../src/db/queries.js", () => ({
  startEvolutionRun,
  finishEvolutionRun,
  getEvolutionFindingsByFingerprint,
  upsertEvolutionFinding,
  resolveMissingEvolutionFindings,
}));

const { persistFindingsForRun } = await import("../../../src/evolution/persist-findings.js");
const { computeFingerprint } = await import("../../../src/evolution/fingerprint.js");

beforeEach(() => {
  store = new Map();
  runIdCounter = 0;
  startedRuns.length = 0;
  finishedRuns.length = 0;
  vi.clearAllMocks();
});

const deadExport = (subject: string, location = "src/x.ts"): Finding => ({
  kind: "dead-export",
  subject,
  location,
  evidence: `"${subject}" is exported from ${location} but appears exactly once.`,
  severity: "low",
});

describe("persistFindingsForRun", () => {
  it("two consecutive runs over an unchanged finding set produce ONE row with times_seen=2", async () => {
    const f = deadExport("unusedThing");
    const input = {
      tenantId: "turicks",
      commitSha: "abc123",
      loop: "audit" as const,
      analyzerResults: [{ analyzer: "findDeadExports", findings: [f] }],
    };

    const first = await persistFindingsForRun(input);
    expect(first.persisted).toBe(true);
    expect(first.newCount).toBe(1);
    expect(first.recurringCount).toBe(0);

    const second = await persistFindingsForRun(input);
    expect(second.persisted).toBe(true);
    expect(second.newCount).toBe(0);
    expect(second.recurringCount).toBe(1);

    expect(store.size).toBe(1);
    const row = store.get(computeFingerprint(f))!;
    expect(row.times_seen).toBe(2);
    expect(row.status).toBe("open");
  });

  it("a resolved finding reappearing (its analyzer in coverage) flips to regressed", async () => {
    const f = deadExport("comesBack");
    const analyzerResults = [{ analyzer: "findDeadExports", findings: [f] }];

    // Run 1: finding present.
    await persistFindingsForRun({ tenantId: "t", commitSha: null, loop: "audit", analyzerResults });

    // Run 2: same analyzer runs, finding gone -> coverage-gated resolution.
    await persistFindingsForRun({ tenantId: "t", commitSha: null, loop: "audit", analyzerResults: [{ analyzer: "findDeadExports", findings: [] }] });
    expect(store.get(computeFingerprint(f))!.status).toBe("resolved");

    // Run 3: same analyzer runs again, finding is back.
    const third = await persistFindingsForRun({ tenantId: "t", commitSha: null, loop: "audit", analyzerResults });

    expect(third.regressedCount).toBe(1);
    expect(third.regressed).toHaveLength(1);
    expect(third.regressed[0]!.subject).toBe("comesBack");
    expect(store.get(computeFingerprint(f))!.status).toBe("regressed");
  });

  it("an analyzer excluded from a run leaves its prior findings' status untouched", async () => {
    const untouched = deadExport("stillThere");
    const other: Finding = { kind: "cost-hotspot", subject: "sales:gpt-5", evidence: "e", severity: "high" };

    // Run 1: both analyzers ran; both findings recorded open.
    await persistFindingsForRun({
      tenantId: "t",
      commitSha: null,
      loop: "audit",
      analyzerResults: [
        { analyzer: "findDeadExports", findings: [untouched] },
        { analyzer: "findCostHotspots", findings: [other] },
      ],
    });
    expect(store.get(computeFingerprint(untouched))!.status).toBe("open");

    // Run 2: telemetry (findCostHotspots) skipped entirely — e.g. DB-for-telemetry
    // unreachable. findDeadExports is not in coverage either this time.
    const result = await persistFindingsForRun({
      tenantId: "t",
      commitSha: null,
      loop: "audit",
      analyzerResults: [], // nothing ran
    });

    expect(result.resolvedCount).toBe(0);
    expect(store.get(computeFingerprint(untouched))!.status).toBe("open");
    expect(store.get(computeFingerprint(other))!.status).toBe("open");
  });

  it("an analyzer present in coverage but with zero findings resolves all its prior open findings", async () => {
    const f = deadExport("goingAway");
    await persistFindingsForRun({
      tenantId: "t",
      commitSha: null,
      loop: "audit",
      analyzerResults: [{ analyzer: "findDeadExports", findings: [f] }],
    });

    const result = await persistFindingsForRun({
      tenantId: "t",
      commitSha: null,
      loop: "audit",
      analyzerResults: [{ analyzer: "findDeadExports", findings: [] }],
    });

    expect(result.resolvedCount).toBe(1);
    expect(store.get(computeFingerprint(f))!.status).toBe("resolved");
  });

  it("records which analyzers ran as this run's coverage", async () => {
    await persistFindingsForRun({
      tenantId: "t",
      commitSha: "sha1",
      loop: "acting",
      analyzerResults: [
        { analyzer: "findDeadExports", findings: [] },
        { analyzer: "findCostHotspots", findings: [] },
      ],
    });

    expect(startedRuns).toHaveLength(1);
    expect(startedRuns[0]!.analyzers_run).toEqual(["findDeadExports", "findCostHotspots"]);
    expect(startedRuns[0]!.loop).toBe("acting");
  });

  it("closes the run row with the deduped findings count", async () => {
    const f = deadExport("x");
    await persistFindingsForRun({
      tenantId: "t",
      commitSha: null,
      loop: "audit",
      analyzerResults: [{ analyzer: "findDeadExports", findings: [f] }],
    });

    expect(finishedRuns).toHaveLength(1);
    expect(finishedRuns[0]!.findings_count).toBe(1);
    expect(finishedRuns[0]!.outcome).toBe("completed");
  });

  it("fails open on a store outage: no throw, persisted=false, zeroed counts, error surfaced", async () => {
    startEvolutionRun.mockRejectedValueOnce(new Error("connection refused"));

    const result = await persistFindingsForRun({
      tenantId: "t",
      commitSha: null,
      loop: "audit",
      analyzerResults: [{ analyzer: "findDeadExports", findings: [deadExport("x")] }],
    });

    expect(result).toEqual({
      persisted: false,
      runId: null,
      newCount: 0,
      recurringCount: 0,
      regressedCount: 0,
      resolvedCount: 0,
      regressed: [],
      error: "connection refused",
    });
  });

  it("de-dupes two findings that fingerprint identically within one run", async () => {
    const f = deadExport("dup");
    const result = await persistFindingsForRun({
      tenantId: "t",
      commitSha: null,
      loop: "audit",
      analyzerResults: [{ analyzer: "findDeadExports", findings: [f, { ...f }] }],
    });

    expect(result.newCount).toBe(1);
    expect(store.size).toBe(1);
  });
});
