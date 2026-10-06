/**
 * Unit tests — the spec gate (src/tools/spec-gate.ts).
 * ====================================================
 * The gate is pure: file existence and risk globs are injected. A spec that cannot be checked
 * must come back as a founder-readable QUESTION, never as a guessed plan. Code may only RAISE
 * the model's risk. Each failure mode has its own case, plus the adversarial ones: a citation on
 * another sha, a line past EOF, a locked test inside scope, a scope that edits CI.
 */
import { describe, it, expect } from "vitest";
import { runSpecGate, type SpecGateDeps } from "../../../src/tools/spec-gate.js";
import { parseTaskContract, type TaskContract } from "../../../src/tools/task-contract.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

function rawContract(): Record<string, any> {
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

/** Parse through the real schema; `patch` edits the raw object first. */
function contract(patch: (c: Record<string, any>) => void = () => {}): TaskContract {
  const raw = rawContract();
  patch(raw);
  const r = parseTaskContract(raw);
  if (!r.ok) throw new Error("fixture invalid: " + r.errors.join("; "));
  return r.contract;
}

function deps(over: Partial<SpecGateDeps> = {}): SpecGateDeps {
  return {
    fileLineCount: (path, sha) => (sha === SHA && path === "src/gateway/tasks.ts" ? 120 : null),
    riskPaths: ["src/infra/hitl.ts", "src/db/migrations/**", "src/tools/billing/**"],
    ...over,
  };
}

describe("runSpecGate: PASS", () => {
  it("passes a valid contract with no questions and keeps the model risk", () => {
    const r = runSpecGate(contract(), deps());
    expect(r.status).toBe("PASS");
    expect(r.questions).toEqual([]);
    expect(r.effectiveRisk).toBe("low");
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a citation on the last line of the file", () => {
    const r = runSpecGate(contract((c) => (c.current_behavior.citations[0].line = 120)), deps());
    expect(r.status).toBe("PASS");
  });

  it("accepts *.test.ts and *.spec.ts locked tests outside tests/", () => {
    const r = runSpecGate(
      contract((c) => (c.locked_tests = ["src/gateway/tasks.test.ts", "src/x/y.spec.ts"])),
      deps(),
    );
    expect(r.status).toBe("PASS");
  });
});

describe("runSpecGate: citations", () => {
  it("asks when a citation sits on a different sha than base_sha, naming it", () => {
    const r = runSpecGate(contract((c) => (c.current_behavior.citations[0].sha = OTHER_SHA)), deps());
    expect(r.status).toBe("ASK");
    expect(r.questions.join("\n")).toContain("src/gateway/tasks.ts:42@fedcba9");
    expect(r.questions.join("\n")).toMatch(/base commit 0123456/);
  });

  it("asks when the line is past the end of the file", () => {
    const r = runSpecGate(contract((c) => (c.current_behavior.citations[0].line = 121)), deps());
    expect(r.status).toBe("ASK");
    expect(r.questions.join("\n")).toMatch(/src\/gateway\/tasks\.ts:121@0123456.*120 lines/);
  });

  it("asks when the cited file does not exist at that sha", () => {
    const r = runSpecGate(contract((c) => (c.current_behavior.citations[0].path = "src/gateway/nope.ts")), deps());
    expect(r.status).toBe("ASK");
    expect(r.questions.join("\n")).toMatch(/src\/gateway\/nope\.ts:42@0123456.*does not exist/);
  });

  it("asks once per bad citation", () => {
    const r = runSpecGate(
      contract((c) =>
        c.current_behavior.citations.push(
          { path: "src/a.ts", line: 1, sha: SHA },
          { path: "src/b.ts", line: 1, sha: SHA },
        ),
      ),
      deps(),
    );
    expect(r.questions.length).toBe(2);
  });

  it("asks when a citation path escapes the repo, even if the reader would find it", () => {
    const r = runSpecGate(
      contract((c) => (c.current_behavior.citations[0].path = "../etc/passwd")),
      deps({ fileLineCount: () => 999 }),
    );
    expect(r.status).toBe("ASK");
  });

  it("asks when there are no citations (a contract that skipped the schema)", () => {
    const c = contract();
    c.current_behavior.citations = [];
    const r = runSpecGate(c, deps());
    expect(r.status).toBe("ASK");
    expect(r.questions.join("\n")).toMatch(/path:line/);
  });
});

describe("runSpecGate: locked tests", () => {
  it("asks when a locked test is not a test file", () => {
    const r = runSpecGate(contract((c) => (c.locked_tests = ["src/gateway/tasks.ts"])), deps());
    expect(r.status).toBe("ASK");
    expect(r.questions.join("\n")).toContain("src/gateway/tasks.ts");
  });

  it("asks when a locked test is inside scope (exact path)", () => {
    const r = runSpecGate(
      contract((c) => (c.scope = ["src/gateway/tasks.ts", "tests/unit/gateway/tasks.test.ts"])),
      deps(),
    );
    expect(r.status).toBe("ASK");
    expect(r.questions.join("\n")).toMatch(/locked test.*tests\/unit\/gateway\/tasks\.test\.ts.*scope/i);
  });

  it("asks when a locked test is inside scope (glob)", () => {
    const r = runSpecGate(contract((c) => (c.scope = ["tests/**"])), deps());
    expect(r.status).toBe("ASK");
    expect(r.questions.join("\n")).toMatch(/locked test/i);
  });

  it("asks when there are no locked tests", () => {
    const c = contract();
    c.locked_tests = [];
    expect(runSpecGate(c, deps()).status).toBe("ASK");
  });
});

describe("runSpecGate: scope", () => {
  it("asks on an empty scope", () => {
    const c = contract();
    c.scope = [];
    const r = runSpecGate(c, deps());
    expect(r.status).toBe("ASK");
    expect(r.questions.join("\n")).toMatch(/scope/i);
  });

  it("asks on `..` segments, absolute paths, backslashes and empty entries", () => {
    for (const bad of ["../other/x.ts", "src/../../x.ts", "/etc/hosts", "~/x.ts", "C:/x.ts", "src\\x.ts", ""]) {
      const r = runSpecGate(contract((c) => (c.scope = [bad])), deps());
      expect(r.status, `scope ${JSON.stringify(bad)}`).toBe("ASK");
    }
  });

  it("asks when scope edits CI, lint, deps or verification scripts", () => {
    const forbidden = [
      ".github/workflows/ci.yml",
      ".github/**",
      "package.json",
      "pnpm-lock.yaml",
      "eslint.config.js",
      "tsconfig.json",
      "vitest.config.ts",
      "vitest.setup.ts",
      "scripts/verify-architecture.ts",
      "scripts/verify-*",
      "packages/web/package.json",
      "governance/architecture-baseline.json",
      ".eslintrc.json",
      ".husky/pre-commit",
      "**",
      "*",
    ];
    for (const bad of forbidden) {
      const r = runSpecGate(contract((c) => (c.scope = ["src/gateway/tasks.ts", bad])), deps());
      expect(r.status, `scope ${bad}`).toBe("ASK");
      expect(r.questions.join("\n")).toContain(bad);
    }
  });

  it("allows ordinary scopes that merely look close to the forbidden ones", () => {
    for (const ok of ["src/**", "scripts/telegram-probe.ts", "src/tools/package-info.ts", "docs/.github-notes.md"]) {
      const r = runSpecGate(contract((c) => (c.scope = [ok])), deps());
      expect(r.status, `scope ${ok}`).toBe("PASS");
    }
  });
});

describe("runSpecGate: task_type", () => {
  it("asks when task_type is outside the supported three", () => {
    const c = contract();
    (c as { task_type: string }).task_type = "migration";
    const r = runSpecGate(c, deps());
    expect(r.status).toBe("ASK");
    expect(r.questions.join("\n")).toMatch(/migration/);
  });
});

describe("runSpecGate: risk is only ever raised", () => {
  it("raises low to high when scope names a risk path exactly", () => {
    const r = runSpecGate(contract((c) => (c.scope = ["src/infra/hitl.ts"])), deps());
    expect(r.effectiveRisk).toBe("high");
    expect(r.status).toBe("PASS");
  });

  it("raises when a scope glob covers a risk path", () => {
    expect(runSpecGate(contract((c) => (c.scope = ["src/infra/**"])), deps()).effectiveRisk).toBe("high");
    expect(runSpecGate(contract((c) => (c.scope = ["src/db/migrations/0042_x.sql"])), deps()).effectiveRisk).toBe("high");
  });

  it("raises when a risk glob covers a scope path", () => {
    expect(runSpecGate(contract((c) => (c.scope = ["src/tools/billing/stripe.ts"])), deps()).effectiveRisk).toBe("high");
  });

  it("keeps a model-proposed high even when nothing overlaps", () => {
    expect(runSpecGate(contract((c) => (c.risk = "high")), deps()).effectiveRisk).toBe("high");
  });

  it("keeps medium when nothing overlaps, never lowers it", () => {
    expect(runSpecGate(contract((c) => (c.risk = "medium")), deps()).effectiveRisk).toBe("medium");
  });

  it("resolves an unrecognised model risk to high, never lower", () => {
    const c = contract();
    (c as { risk: string }).risk = "negligible";
    expect(runSpecGate(c, deps()).effectiveRisk).toBe("high");
  });

  it("does not raise for a non-overlapping scope, and tolerates an empty riskPaths", () => {
    expect(runSpecGate(contract(), deps()).effectiveRisk).toBe("low");
    expect(runSpecGate(contract(), deps({ riskPaths: [] })).effectiveRisk).toBe("low");
  });

  it("does not treat sibling files as overlapping", () => {
    expect(runSpecGate(contract((c) => (c.scope = ["src/infra/hitl-extra.ts"])), deps()).effectiveRisk).toBe("low");
  });
});

describe("runSpecGate: fingerprint", () => {
  const fp = (c: TaskContract) => runSpecGate(c, deps()).fingerprint;

  it("is stable across calls", () => {
    expect(fp(contract())).toBe(fp(contract()));
  });

  it("is stable under scope and locked_tests reordering and ask whitespace", () => {
    const a = contract((c) => {
      c.scope = ["src/a.ts", "src/b.ts"];
      c.locked_tests = ["tests/a.test.ts", "tests/b.test.ts"];
    });
    const b = contract((c) => {
      c.scope = ["src/b.ts", "src/a.ts"];
      c.locked_tests = ["tests/b.test.ts", "tests/a.test.ts"];
      c.ask = "  the /tasks list shows closed issues,   hide them \n";
    });
    expect(fp(a)).toBe(fp(b));
  });

  it("differs across asks, repos, base shas, scope and locked tests", () => {
    const base = fp(contract());
    const variants = [
      contract((c) => (c.ask = "hide closed tasks")),
      contract((c) => (c.repo = "pushkarverma3698/oplify")),
      contract((c) => {
        c.base_sha = OTHER_SHA;
        c.current_behavior.citations[0].sha = OTHER_SHA;
      }),
      contract((c) => (c.scope = ["src/gateway/tasks.ts", "src/gateway/other.ts"])),
      contract((c) => (c.locked_tests = ["tests/unit/gateway/other.test.ts"])),
    ];
    const all = new Set([base, ...variants.map(fp)]);
    expect(all.size).toBe(variants.length + 1);
  });

  it("does not collide when a path moves between scope and locked_tests", () => {
    const a = contract((c) => {
      c.scope = ["src/a.ts", "src/b.ts"];
      c.locked_tests = ["tests/c.test.ts"];
    });
    const b = contract((c) => {
      c.scope = ["src/a.ts"];
      c.locked_tests = ["src/b.ts", "tests/c.test.ts"];
    });
    expect(fp(a)).not.toBe(fp(b));
  });

  it("ignores the model-owned risk field", () => {
    expect(fp(contract((c) => (c.risk = "high")))).toBe(fp(contract()));
  });
});

describe("runSpecGate: purity", () => {
  it("does not mutate its input", () => {
    const c = contract((c) => (c.scope = ["src/b.ts", "src/a.ts"]));
    const snapshot = JSON.stringify(c);
    runSpecGate(c, deps());
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});
