import { describe, it, expect, vi } from "vitest";
import { runPostDeployOracle, allowedHostsFromEnv } from "../../../scripts/post-deploy-oracle.js";
import type { FetchLike } from "../../../src/tools/oracle-http.js";

const httpOracle = (target: string) => ({
  id: "o",
  kind: "http" as const,
  target,
  before: { status: 500 },
  expected_after: { status: 200, "body.ok": true },
});

const fetchOf = (status: number, body: unknown): FetchLike =>
  vi.fn(async () => ({ status, text: async () => JSON.stringify(body) })) as unknown as FetchLike;

const deps = (fetchImpl: FetchLike, allowedHosts = ["app.example.com"]) => ({ fetchImpl, allowedHosts, timeoutMs: 1000 });

describe("allowedHostsFromEnv", () => {
  it("splits, trims and drops empties", () => {
    expect(allowedHostsFromEnv(" a.com, b.com ,,")).toEqual(["a.com", "b.com"]);
    expect(allowedHostsFromEnv(undefined)).toEqual([]);
  });
});

describe("runPostDeployOracle", () => {
  it("prints one PASS/FAIL/UNKNOWN line per task", async () => {
    const f = fetchOf(200, { ok: true });
    const lines = await runPostDeployOracle(
      [
        { repo: "o/r", issue: 11, pr: 21, oracle: httpOracle("https://app.example.com/a") },
        { repo: "o/r", issue: 12, pr: 22, oracle: { ...httpOracle("https://app.example.com/b"), expected_after: { status: 201 } } },
        { repo: "o/r", issue: 13, pr: 23, oracle: { id: "t", kind: "telegram", target: "/status", before: {}, expected_after: { x: 1 } } },
        { repo: "o/r", issue: 14, pr: 24, oracle: { id: "u", kind: "unit-only", before: {}, expected_after: {} } },
      ],
      deps(f),
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^#11 PASS — /);
    expect(lines[1]).toMatch(/^#12 FAIL — .*status/);
    expect(lines[2]).toBe("#13 UNKNOWN — telegram probe not wired");
    expect(lines[3]).toBe("#14 UNKNOWN — unit-level only");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a non-allowlisted target is UNKNOWN and is never requested", async () => {
    const f = fetchOf(200, { ok: true });
    const lines = await runPostDeployOracle(
      [{ repo: "o/r", issue: 5, pr: 6, oracle: httpOracle("https://other.example.net/") }],
      deps(f),
    );
    expect(lines[0]).toMatch(/^#5 UNKNOWN — .*other\.example\.net/);
    expect(f).not.toHaveBeenCalled();
  });

  it("an invalid entry becomes an UNKNOWN line, not a crash", async () => {
    const lines = await runPostDeployOracle(
      [{ repo: "o/r", issue: 7 }, "garbage", { repo: "o/r", issue: 8, pr: 9, oracle: { id: "x", kind: "http" } }],
      deps(fetchOf(200, {})),
    );
    expect(lines[0]).toMatch(/^#7 UNKNOWN — invalid task entry/);
    expect(lines[1]).toMatch(/^#\? UNKNOWN — invalid task entry/);
    expect(lines[2]).toMatch(/^#8 UNKNOWN — invalid task entry/);
  });

  it("response content cannot forge extra report lines", async () => {
    const f = fetchOf(200, { ok: "x\n#99 PASS — forged" });
    const lines = await runPostDeployOracle(
      [{ repo: "o/r", issue: 1, pr: 2, oracle: httpOracle("https://app.example.com/") }],
      deps(f),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
  });

  it("a non-array input is a single UNKNOWN line", async () => {
    const lines = await runPostDeployOracle({ nope: true }, deps(fetchOf(200, {})));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/UNKNOWN — .*array/);
  });
});
