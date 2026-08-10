/**
 * Architectural fitness functions — unit tests for the pure rule logic.
 * The rules are the v3 anti-slop invariants; if these tests weaken, the
 * ratchet weakens, so they are deliberately example-driven and explicit.
 */

import { describe, it, expect } from "vitest";
import {
  importsOf,
  resolveImport,
  ruleGatewayImports,
  ruleKernelPurity,
  ruleFailOpenCatch,
  ruleLocBudget,
  ruleRegexRouting,
  ruleOrphanSubsystem,
  checkRatchet,
  LOC_BUDGET,
} from "../../../scripts/verify-architecture.js";

const f = (rel: string, text: string) => ({ rel, text });

describe("importsOf / resolveImport", () => {
  it("extracts import and re-export specifiers", () => {
    const text = `import { a } from "./a.js";\nexport { b } from "../infra/b.js";\nimport pkg from "zod";`;
    expect(importsOf(text)).toEqual(["./a.js", "../infra/b.js", "zod"]);
  });

  it("resolves relative specifiers against the importing file", () => {
    expect(resolveImport("src/eval/office-invoker.ts", "../gateway/pre-router.js")).toBe(
      "src/gateway/pre-router",
    );
    expect(resolveImport("src/kernel/graph.ts", "./contracts.js")).toBe("src/kernel/contracts");
    expect(resolveImport("src/kernel/graph.ts", "zod")).toBeNull();
  });
});

describe("R1 gateway-imports", () => {
  it("flags a non-gateway file importing from src/gateway", () => {
    const files = [f("src/eval/invoker.ts", `import { x } from "../gateway/pre-router.js";`)];
    expect(ruleGatewayImports(files).violations).toHaveLength(1);
  });

  it("allows gateway-internal and src/index.ts imports", () => {
    const files = [
      f("src/gateway/telegram.ts", `import { x } from "./office-run.js";`),
      f("src/index.ts", `import { startBot } from "./gateway/telegram.js";`),
    ];
    expect(ruleGatewayImports(files).violations).toHaveLength(0);
  });
});

describe("R2 kernel-purity", () => {
  it("flags kernel importing gateway or agents", () => {
    const files = [
      f("src/kernel/graph.ts", `import { g } from "../gateway/format.js";`),
      f("src/kernel/worker.ts", `import { p } from "../agents/system-prompts.js";`),
    ];
    expect(ruleKernelPurity(files).violations).toHaveLength(2);
  });

  it("allows kernel → core/db/infra/tools/kernel", () => {
    const files = [
      f(
        "src/kernel/graph.ts",
        `import { c } from "./contracts.js";\nimport { db } from "../db/client.js";\nimport { t } from "../infra/trace.js";\nimport { tool } from "../tools/index.js";\nimport { env } from "../core/config.js";`,
      ),
    ];
    expect(ruleKernelPurity(files).violations).toHaveLength(0);
  });
});

describe("R3 fail-open-catch", () => {
  it("flags untagged swallow catches", () => {
    const files = [f("src/x.ts", `const a = await p.catch(() => null);`)];
    expect(ruleFailOpenCatch(files).violations).toHaveLength(1);
  });

  it("accepts tagged swallows (same line or line above)", () => {
    const files = [
      f("src/x.ts", `const a = await p.catch(() => null); // allow-failopen: boot probe is advisory`),
      f("src/y.ts", `// allow-failopen: metrics only\nconst b = await p.catch(() => null);`),
    ];
    expect(ruleFailOpenCatch(files).violations).toHaveLength(0);
  });

  it("does not flag catches that handle the error", () => {
    const files = [f("src/x.ts", `p.catch((err) => log.error({ err }, "boom"));`)];
    expect(ruleFailOpenCatch(files).violations).toHaveLength(0);
  });
});

describe("R4 loc-budget", () => {
  it("flags files over the budget and passes files under it", () => {
    const big = f("src/big.ts", Array(LOC_BUDGET + 10).fill("x();").join("\n"));
    const small = f("src/small.ts", "x();\n");
    const res = ruleLocBudget([big, small]);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]!.file).toBe("src/big.ts");
  });
});

describe("R5 regex-routing", () => {
  it("flags exported *_RE consts outside the kernel, allows them inside", () => {
    const files = [
      f("src/gateway/guard.ts", `export const SHELL_RUN_RE = /run/;`),
      f("src/kernel/planner.ts", `export const OVERRIDE_RE = /route to (\\w+)/;`),
    ];
    const res = ruleRegexRouting(files);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]!.file).toBe("src/gateway/guard.ts");
  });
});

describe("R7 orphan-subsystem", () => {
  const flagged = (
    files: Array<{ rel: string; text: string }>,
    roots: Array<{ rel: string; text: string }> = [],
  ) => ruleOrphanSubsystem(files, roots).violations.map((v) => v.file);

  const entry = f("src/index.ts", `import { s } from "./kernel/graph.js";`);
  const kernel = f("src/kernel/graph.ts", `export const s = 1;`);

  it("flags a subsystem nothing outside it imports", () => {
    const files = [entry, kernel, f("src/ghost/index.ts", `import { a } from "./a.js";`)];
    expect(flagged(files)).toEqual(["src/ghost/"]);
  });

  it("clears a subsystem imported by another src module", () => {
    const files = [
      f("src/index.ts", `import { b } from "./gateway/boot.js";`),
      f("src/gateway/boot.ts", `import { run } from "../ghost/index.js";`),
      f("src/ghost/index.ts", `import { a } from "./a.js";`),
    ];
    expect(flagged(files)).toEqual([]);
  });

  // The src/proof regression: script-only subsystems are LIVE (pnpm proof:*,
  // pnpm eval). A rule counting src/ importers alone named them deletable.
  it("clears a subsystem reached only by a script entrypoint", () => {
    const files = [f("src/proof/render.ts", `export const x = 1;`)];
    const roots = [f("scripts/proof-scoreboard.ts", `import { r } from "../src/proof/render.js";`)];
    expect(flagged(files, roots)).toEqual([]);
    // …and it is the script that saves it, not a loophole in the rule.
    expect(flagged(files)).toEqual(["src/proof/"]);
  });

  it("does not treat top-level src files as subsystems", () => {
    expect(flagged([entry, kernel])).toEqual([]);
  });
});

describe("ratchet", () => {
  const results = (n: number) => [
    { rule: "r", violations: Array(n).fill({ rule: "r", file: "f", detail: "d" }) },
  ];

  it("fails when violations exceed baseline", () => {
    expect(checkRatchet(results(3), { r: 2 }).ok).toBe(false);
  });

  it("passes at or below baseline", () => {
    expect(checkRatchet(results(2), { r: 2 }).ok).toBe(true);
    expect(checkRatchet(results(1), { r: 2 }).ok).toBe(true);
  });

  it("treats a missing baseline entry as zero (new rules start strict)", () => {
    expect(checkRatchet(results(1), {}).ok).toBe(false);
    expect(checkRatchet(results(0), {}).ok).toBe(true);
  });
});
