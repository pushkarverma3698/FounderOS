import { describe, it, expect } from "vitest";
import { satisfies, readOracleMarkers, parseOracleMarkers, evaluatePostDeploy, type Oracle } from "../../../src/tools/oracle.js";

const http: Oracle = {
  id: "pay-1",
  kind: "http",
  target: "https://app.example.com/pay",
  before: { status: 500 },
  expected_after: { status: 200, "body.payment_status": "completed" },
};

describe("satisfies", () => {
  it("passes on exact match including dotted paths", () => {
    const actual = { status: 200, body: { payment_status: "completed" } };
    expect(satisfies(actual, http.expected_after)).toEqual({ ok: true, mismatches: [] });
  });

  it("names every wrong value", () => {
    const r = satisfies({ status: 500, body: { payment_status: "pending" } }, http.expected_after);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toHaveLength(2);
    expect(r.mismatches.join("|")).toContain("status");
    expect(r.mismatches.join("|")).toContain("body.payment_status");
  });

  it("treats a missing key as a mismatch and names it", () => {
    const r = satisfies({ status: 200, body: {} }, http.expected_after);
    expect(r.ok).toBe(false);
    expect(r.mismatches[0]).toMatch(/body\.payment_status.*missing/);
  });

  it("is strict about types: '200' is not 200, null is not missing", () => {
    expect(satisfies({ status: "200" }, { status: 200 }).ok).toBe(false);
    expect(satisfies({ x: null }, { x: null }).ok).toBe(true);
    expect(satisfies({}, { x: null }).ok).toBe(false);
  });

  it("does not walk the prototype chain", () => {
    expect(satisfies({}, { "constructor.name": "Object" }).ok).toBe(false);
    expect(satisfies({}, { "__proto__.x": 1 }).ok).toBe(false);
  });

  it("a non-object actual satisfies nothing", () => {
    expect(satisfies("ok", { status: 200 }).ok).toBe(false);
    expect(satisfies(null, { status: 200 }).ok).toBe(false);
  });
});

describe("readOracleMarkers", () => {
  it("reads id -> json from marker lines and ignores other output", () => {
    const out = [
      "PASS tests/foo.test.ts",
      'FOUNDEROS_ORACLE pay-1 {"status":200,"body":{"payment_status":"completed"}}',
      "noise",
      "FOUNDEROS_ORACLE other 42",
    ].join("\n");
    expect(readOracleMarkers(out)).toEqual({
      "pay-1": { status: 200, body: { payment_status: "completed" } },
      other: 42,
    });
  });

  it("ignores and counts malformed marker lines", () => {
    const out = [
      "FOUNDEROS_ORACLE bad {not json",
      "FOUNDEROS_ORACLE onlyid",
      "FOUNDEROS_ORACLE __proto__ {}",
      'FOUNDEROS_ORACLE ok {"a":1}',
    ].join("\n");
    const r = parseOracleMarkers(out);
    expect(r.markers).toEqual({ ok: { a: 1 } });
    expect(r.malformed).toBe(3);
    expect(readOracleMarkers(out)).toEqual({ ok: { a: 1 } });
  });

  it("handles CRLF and last-wins on a repeated id", () => {
    const out = 'FOUNDEROS_ORACLE a {"v":1}\r\nFOUNDEROS_ORACLE a {"v":2}\r\n';
    expect(readOracleMarkers(out)).toEqual({ a: { v: 2 } });
  });

  it("does not match a marker that is merely quoted mid-line", () => {
    expect(parseOracleMarkers('echo FOUNDEROS_ORACLE a {"v":1}')).toEqual({ markers: {}, malformed: 0 });
  });
});

describe("evaluatePostDeploy", () => {
  it("unit-only is UNKNOWN, even with an observation", () => {
    const r = evaluatePostDeploy({ ...http, kind: "unit-only" }, { actual: { status: 200 } });
    expect(r).toEqual({ status: "UNKNOWN", reason: "unit-level only" });
  });

  it("an observation error is UNKNOWN and carries the error", () => {
    const r = evaluatePostDeploy(http, { error: "timeout after 5000ms" });
    expect(r.status).toBe("UNKNOWN");
    expect(r.reason).toContain("timeout after 5000ms");
  });

  it("no actual is UNKNOWN", () => {
    expect(evaluatePostDeploy(http, {}).status).toBe("UNKNOWN");
  });

  it("PASS when expected_after is satisfied", () => {
    const r = evaluatePostDeploy(http, { actual: { status: 200, body: { payment_status: "completed" } } });
    expect(r.status).toBe("PASS");
  });

  it("FAIL prints each mismatch", () => {
    const r = evaluatePostDeploy(http, { actual: { status: 500, body: {} } });
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("status");
    expect(r.reason).toContain("body.payment_status");
  });

  it("an empty expected_after never passes vacuously", () => {
    const r = evaluatePostDeploy({ ...http, expected_after: {} }, { actual: { status: 200 } });
    expect(r.status).toBe("UNKNOWN");
  });
});
