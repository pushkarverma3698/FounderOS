/**
 * Deploy workflow contract — .github/workflows/deploy.yml.
 * ========================================================
 * Since 2026-10-10 the workflow ships only the jobs process: one step SSHes to the VPS and runs
 * deploy/deploy.sh. The daemon sync and oracle report steps went with the daemons they served.
 * This edits the pipeline that ships production, so a slip here turns every deploy red or, worse,
 * leaks a secret into a public Actions log.
 *
 * There is no YAML parser among the dependencies and none may be added for a test (STANDARDS.md
 * section 10), so, like sync-beta-workflow.test.ts, these assert on the workflow's TEXT and STRUCTURE:
 * the step list is split on its `- name:` items, and each step's `run:` and `env:` blocks are cut by
 * indentation.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOW = readFileSync(fileURLToPath(new URL("../../../.github/workflows/deploy.yml", import.meta.url)), "utf8");
const DEPLOY_SH = readFileSync(fileURLToPath(new URL("../../../deploy/deploy.sh", import.meta.url)), "utf8");

interface Step {
  readonly name: string;
  /** The whole step, comments that precede the next step included. */
  readonly text: string;
  /** The `run: |` script, code and comments, exactly as the runner will execute it. */
  readonly run: string;
  /** The `env:` mapping lines. */
  readonly env: readonly string[];
}

/** Lines after `key: |` (or `key:`) that are blank or indented deeper than the key: a YAML block. */
function block(lines: readonly string[], keyLine: number, keyIndent: number): string[] {
  const out: string[] = [];
  for (let i = keyLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.length - line.trimStart().length > keyIndent) out.push(line);
    else break;
  }
  return out;
}

function steps(): Step[] {
  const lines = WORKFLOW.split("\n");
  const starts = lines.flatMap((l, i) => (/^ {6}- name: /.test(l) ? [i] : []));
  return starts.map((start, k) => {
    const end = starts[k + 1] ?? lines.length;
    const own = lines.slice(start, end);
    const runAt = own.findIndex((l) => /^ {8}run: \|\s*$/.test(l));
    const envAt = own.findIndex((l) => /^ {8}env:\s*$/.test(l));
    return {
      name: (lines[start] ?? "").replace(/^ {6}- name: /, ""),
      text: own.join("\n"),
      run: runAt >= 0 ? block(own, runAt, 8).join("\n") : "",
      env: envAt >= 0 ? block(own, envAt, 8) : [],
    };
  });
}

/** Non-comment, non-blank lines of a script. */
const code = (script: string): string[] => script.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

const all = steps();
const deployStep = all.find((s) => s.run.includes("./deploy/deploy.sh"));

describe("deploy.yml — the deploy step", () => {
  it("the parser finds the steps (a format change must fail here with a clear message, not pass vacuously)", () => {
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(deployStep, "no step runs ./deploy/deploy.sh").toBeDefined();
    expect(deployStep?.run.length).toBeGreaterThan(200);
  });

  it("is the last step, and nothing syncs the retired daemons or runs the oracle report", () => {
    expect(all.at(-1)?.name).toBe(deployStep?.name);
    expect(WORKFLOW).not.toMatch(/sync-daemons|oracle-report/);
  });

  it("deploy.sh restarts the service and then waits on /health", () => {
    const restart = DEPLOY_SH.indexOf("sudo systemctl restart founderos");
    const health = DEPLOY_SH.indexOf("/health", restart);
    expect(restart, "deploy.sh no longer restarts the service").toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(restart);
  });

  it("still sends PROD_DOTENV and the API keys as base64 on stdin, and never as `envs:`", () => {
    expect(deployStep?.run).toContain("emit PROD_DOTENV");
    expect(deployStep?.run).toContain("emit GOOGLE_GENERATIVE_AI_API_KEY");
    expect(deployStep?.run).toMatch(/\| timeout 10m ssh/);
    // Active lines only: a comment may explain that the step USED appleboy/ssh-action with `envs:`
    // until 2026-08-12. What must never come back is a line that does.
    const active = WORKFLOW.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    expect(active).not.toMatch(/^\s*envs:/m);
    expect(active).not.toMatch(/appleboy\/ssh-action/);
  });

  it("keeps its concurrency guard (two deploys never interleave) and its CI-gated trigger", () => {
    expect(WORKFLOW).toMatch(/concurrency:\s*\n\s+group: deploy-production\s*\n\s+cancel-in-progress: false/);
    expect(WORKFLOW).toMatch(/workflows: \["CI"\]/);
    expect(WORKFLOW).toMatch(/github\.event\.workflow_run\.conclusion == 'success'/);
  });
});

describe("deploy.yml — no secret is ever echoed", () => {
  it("every `secrets.X` reference is an `env:` entry of a step, never interpolated into a script or a command", () => {
    const refs = WORKFLOW.split("\n").filter((l) => l.includes("secrets."));
    expect(refs.length).toBeGreaterThan(0);
    for (const line of refs) expect(line, `a secret outside an env: mapping: ${line}`).toMatch(/^ {10}[A-Z][A-Z0-9_]*: \$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}$/);
    for (const s of all) expect(s.run, `${s.name} interpolates \${{ }} into its script`).not.toMatch(/\$\{\{/);
  });

  it("no step turns on shell tracing or dumps the environment", () => {
    for (const s of all) {
      const script = code(s.run).join("\n");
      expect(script, s.name).not.toMatch(/set\s+-[a-z]*x|xtrace/);
      expect(script, s.name).not.toMatch(/\b(printenv)\b|(^|[;&|]\s*)env\s*($|[;&|])/m);
    }
  });
});
