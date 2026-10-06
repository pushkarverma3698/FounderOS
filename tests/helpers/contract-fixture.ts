import type { TaskContract } from "../../src/tools/task-contract.js";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

/** A valid TaskContract for tests. Override any field. */
export function contractFixture(over: Partial<TaskContract> = {}): TaskContract {
  return {
    version: 1,
    ask: "make the oracle report stable",
    repo: "acme/widgets",
    task_type: "bugfix",
    base_sha: SHA_A,
    current_behavior: { text: "it flaps", citations: [{ path: "src/tools/oracle.ts", line: 10, sha: SHA_A }] },
    expected_behavior: "it does not flap",
    scope: ["src/tools/oracle.ts"],
    locked_tests: ["tests/unit/tools/oracle.test.ts"],
    oracle: { id: "o1", kind: "unit-only", before: {}, expected_after: {} },
    risk: "low",
    limits: { files: 5, lines: 200, deleted_lines: 50, new_dependencies: false },
    ...over,
  };
}
