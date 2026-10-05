/**
 * Unit tests — TaskContract schema (src/tools/task-contract.ts).
 * ==============================================================
 * Today a /task issue says "verification = repo's own checks" and "paths: agent to locate"
 * (PRs #895/#899), so the reviewer has nothing to check except green CI. The contract makes the
 * ask checkable: cited current behavior, a locked test, a bounded scope, hard limits. These tests
 * pin what the schema must refuse; the spec gate (spec-gate.test.ts) pins what code refuses on top.
 */
import { describe, it, expect } from "vitest";
import { parseTaskContract, renderCitation } from "../../../src/tools/task-contract.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function validContract(): Record<string, any> {
  return {
    version: 1,
    ask: "the /tasks list shows closed issues, hide them",
    repo: "pushkarverma3698/founderos",
    task_type: "bugfix",
    base_sha: SHA,
    current_behavior: {
      text: "listTasks() returns every issue, including closed ones.",
      citations: [{ path: "src/gateway/tasks.ts", line: 42, sha: SHA }],
    },
    expected_behavior: "listTasks() returns only open issues.",
    scope: ["src/gateway/tasks.ts"],
    locked_tests: ["tests/unit/gateway/tasks.test.ts"],
    oracle: {
      id: "tasks-hide-closed",
      kind: "telegram",
      target: "/tasks",
      before: { "reply.contains_closed": true },
      expected_after: { "reply.contains_closed": false },
    },
    risk: "low",
    limits: { files: 3, lines: 80, deleted_lines: 40, new_dependencies: false },
  };
}

function withPatch(patch: (c: Record<string, any>) => void): Record<string, unknown> {
  const c = validContract();
  patch(c);
  return c;
}

function errorsOf(raw: unknown): string[] {
  const r = parseTaskContract(raw);
  if (r.ok) throw new Error("expected parse failure");
  return r.errors;
}

describe("parseTaskContract: accepts", () => {
  it("a valid contract", () => {
    const r = parseTaskContract(validContract());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contract.task_type).toBe("bugfix");
      expect(r.contract.limits.new_dependencies).toBe(false);
    }
  });

  it("an optional spec_commit and an oracle without target", () => {
    const c = withPatch((x) => {
      x.spec_commit = "f".repeat(40);
      x.oracle = { id: "u", kind: "unit-only", before: {}, expected_after: {} };
    });
    expect(parseTaskContract(c).ok).toBe(true);
  });
});

describe("parseTaskContract: refuses", () => {
  it("non-objects", () => {
    expect(errorsOf(null).length).toBeGreaterThan(0);
    expect(errorsOf("fix it").length).toBeGreaterThan(0);
  });

  it("empty citations, naming the field", () => {
    const errs = errorsOf(withPatch((c) => (c.current_behavior.citations = [])));
    expect(errs.join("\n")).toMatch(/current_behavior\.citations.*at least one citation/i);
  });

  it("a citation line below 1 or fractional", () => {
    expect(errorsOf(withPatch((c) => (c.current_behavior.citations[0].line = 0))).join("\n")).toMatch(/line/);
    expect(errorsOf(withPatch((c) => (c.current_behavior.citations[0].line = 4.5))).join("\n")).toMatch(/line/);
  });

  it("a short or non-hex sha on base_sha and on a citation", () => {
    expect(errorsOf(withPatch((c) => (c.base_sha = "abc1234"))).join("\n")).toMatch(/base_sha.*40/);
    expect(errorsOf(withPatch((c) => (c.current_behavior.citations[0].sha = "HEAD"))).join("\n")).toMatch(/sha.*40/);
    expect(errorsOf(withPatch((c) => (c.base_sha = "g".repeat(40)))).length).toBeGreaterThan(0);
  });

  it("no locked tests", () => {
    expect(errorsOf(withPatch((c) => (c.locked_tests = []))).join("\n")).toMatch(/locked_tests.*at least one/i);
  });

  it("new_dependencies true, and limits that are zero, negative or fractional", () => {
    expect(errorsOf(withPatch((c) => (c.limits.new_dependencies = true))).join("\n")).toMatch(/new_dependencies/);
    expect(errorsOf(withPatch((c) => (c.limits.files = 0))).join("\n")).toMatch(/limits\.files/);
    expect(errorsOf(withPatch((c) => (c.limits.lines = -5))).join("\n")).toMatch(/limits\.lines/);
    expect(errorsOf(withPatch((c) => (c.limits.deleted_lines = 1.5))).join("\n")).toMatch(/limits\.deleted_lines/);
  });

  it("unknown keys at the top level, in limits and in a citation (strict)", () => {
    expect(errorsOf(withPatch((c) => (c.extra = 1))).join("\n")).toMatch(/extra/);
    expect(errorsOf(withPatch((c) => (c.limits.network = true))).join("\n")).toMatch(/network/);
    expect(errorsOf(withPatch((c) => (c.current_behavior.citations[0].col = 3))).join("\n")).toMatch(/col/);
  });

  it("an unknown risk, oracle kind, or version", () => {
    expect(errorsOf(withPatch((c) => (c.risk = "critical"))).join("\n")).toMatch(/risk/);
    expect(errorsOf(withPatch((c) => (c.oracle.kind = "shell"))).join("\n")).toMatch(/oracle\.kind/);
    expect(errorsOf(withPatch((c) => (c.version = 2))).join("\n")).toMatch(/version/);
  });

  it("a repo that is not owner/name", () => {
    expect(errorsOf(withPatch((c) => (c.repo = "founderos"))).join("\n")).toMatch(/repo/);
  });

  it("an empty ask or expected_behavior", () => {
    expect(errorsOf(withPatch((c) => (c.ask = "   "))).join("\n")).toMatch(/ask/);
    expect(errorsOf(withPatch((c) => (c.expected_behavior = ""))).join("\n")).toMatch(/expected_behavior/);
  });

  it("a predicate value that is not a scalar", () => {
    expect(errorsOf(withPatch((c) => (c.oracle.before = { a: { b: 1 } }))).join("\n")).toMatch(/oracle\.before/);
  });

  it("reports every problem, not just the first", () => {
    const errs = errorsOf(
      withPatch((c) => {
        c.locked_tests = [];
        c.risk = "x";
      }),
    );
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("renderCitation", () => {
  it("renders path:line@sha7", () => {
    expect(renderCitation({ path: "src/a.ts", line: 7, sha: SHA })).toBe("src/a.ts:7@0123456");
  });
});
