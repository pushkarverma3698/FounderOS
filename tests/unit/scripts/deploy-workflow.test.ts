/**
 * Deploy workflow contract — .github/workflows/deploy.yml.
 * ========================================================
 * The daemons deploy with the app: after the service restart, a step copies deploy/agent-dispatch,
 * deploy/vps-daemons/pr-brain, deploy/onboard-repo.sh and deploy/lib/*.sh into ~/bin and compares
 * sha256 against the checkout. This edits the pipeline that ships production, so a slip here turns
 * every deploy red or, worse, leaks a secret into a public Actions log.
 *
 * There is no YAML parser among the dependencies and none may be added for a test (STANDARDS.md
 * section 10), so, like sync-beta-workflow.test.ts, these assert on the workflow's TEXT and STRUCTURE:
 * the step list is split on its `- name:` items, and each step's `run:` and `env:` blocks are cut by
 * indentation. The behaviour of what the step runs is tested where it lives, in sync-daemons.test.ts.
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
const syncStep = all.find((s) => s.run.includes("deploy/sync-daemons.sh"));
const deployStep = all.find((s) => s.run.includes("./deploy/deploy.sh"));

describe("deploy.yml — the daemon sync step", () => {
  it("the parser finds the steps (a format change must fail here with a clear message, not pass vacuously)", () => {
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(deployStep, "no step runs ./deploy/deploy.sh").toBeDefined();
    expect(deployStep?.run.length).toBeGreaterThan(200);
  });

  it("exists, exactly once, and runs deploy/sync-daemons.sh on the VPS", () => {
    const matches = all.filter((s) => s.run.includes("deploy/sync-daemons.sh"));
    expect(matches, "no step runs deploy/sync-daemons.sh: the daemons would go back to being copied by hand").toHaveLength(1);
    expect(syncStep?.name).toMatch(/daemon/i);
    expect(syncStep?.run).toMatch(/ssh[\s\S]*'cd \/opt\/founderos && bash deploy\/sync-daemons\.sh'/);
  });

  it("runs AFTER the step that restarts the service", () => {
    expect(deployStep && syncStep).toBeTruthy();
    const deployIndex = all.indexOf(deployStep as Step);
    const syncIndex = all.indexOf(syncStep as Step);
    expect(syncIndex, "the sync step must come after the deploy step").toBeGreaterThan(deployIndex);
    // ...and the restart really IS in what that earlier step runs (deploy.sh), before its health wait.
    const restart = DEPLOY_SH.indexOf("sudo systemctl restart founderos");
    const health = DEPLOY_SH.indexOf("/health", restart);
    expect(restart, "deploy.sh no longer restarts the service").toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(restart);
  });

  it("is in the same job as the deploy, so a failure fails the job (no continue-on-error, no swallowed exit)", () => {
    expect(syncStep?.text).not.toMatch(/continue-on-error/);
    expect(syncStep?.text).not.toMatch(/^\s{6,8}if:/m);
    const script = code(syncStep?.run ?? "").join("\n");
    expect(script).toMatch(/set -euo pipefail/);
    expect(script).not.toMatch(/\|\|\s*(true|:)\b/);
    expect(script).not.toMatch(/set \+e/);
    // one job, and both steps are inside it
    expect(WORKFLOW.match(/^jobs:\s*$/gm)).toHaveLength(1);
    const lines = WORKFLOW.split("\n");
    const jobAt = lines.findIndex((l) => /^ {2}deploy:\s*$/.test(l));
    expect(jobAt).toBeGreaterThan(-1);
    for (const s of [deployStep, syncStep]) expect(lines.findIndex((l) => l === `      - name: ${s?.name}`)).toBeGreaterThan(jobAt);
  });

  it("stays thin: the copy and verify logic lives in the script, not in YAML", () => {
    const lines = code(syncStep?.run ?? "");
    expect(lines.length).toBeLessThan(25);
    expect(syncStep?.run).not.toMatch(/sha256sum|shasum|\bcp\b|\bmv\b|\bscp\b|rsync/);
  });
});

describe("deploy.yml — no secret is ever echoed", () => {
  it("every `secrets.X` reference is an `env:` entry of a step, never interpolated into a script or a command", () => {
    const refs = WORKFLOW.split("\n").filter((l) => l.includes("secrets."));
    expect(refs.length).toBeGreaterThan(0);
    for (const line of refs) expect(line, `a secret outside an env: mapping: ${line}`).toMatch(/^ {10}[A-Z][A-Z0-9_]*: \$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}$/);
    for (const s of all) expect(s.run, `${s.name} interpolates \${{ }} into its script`).not.toMatch(/\$\{\{/);
  });

  it("the sync step's only credential is the SSH key, written to a 0600 temp file and never echoed", () => {
    const envKeys = (syncStep?.env ?? []).map((l) => l.trim().split(":")[0]);
    expect(envKeys.sort()).toEqual(["DEPLOY_HOST", "DEPLOY_PORT", "DEPLOY_SSH_KEY", "DEPLOY_USER"]);

    const script = code(syncStep?.run ?? "");
    const keyLines = script.filter((l) => l.includes("DEPLOY_SSH_KEY"));
    expect(keyLines.map((l) => l.trim())).toEqual([`printf '%s\\n' "$DEPLOY_SSH_KEY" > "$KEY_FILE"`]);
    expect(script.join("\n")).toMatch(/chmod 600 "\$KEY_FILE"/);
    expect(script.join("\n")).toMatch(/trap 'rm -f "\$KEY_FILE"' EXIT/);
    expect(script.join("\n")).not.toMatch(/\b(echo|printenv|tee|declare\s+-p|export\s+-p)\b/);
    expect(script.join("\n")).not.toMatch(/\benv\b(?!:)/);
    expect(script.join("\n")).not.toMatch(/set\s+-[a-z]*x|xtrace|--verbose|\s-v\b/);
  });

  it("no secret is on any command line: the ssh arguments are the key FILE, the port, options and the host, and the remote command is a fixed string", () => {
    const script = code(syncStep?.run ?? "").join("\n");
    const ssh = /timeout \d+m ssh([\s\S]*?)<\/dev\/null/.exec(script)?.[1] ?? "";
    expect(ssh).not.toBe("");
    expect(ssh).toContain('-i "$KEY_FILE"');
    expect(ssh).not.toContain("DEPLOY_SSH_KEY");
    expect(ssh).toContain("BatchMode=yes");
    const remote = /'(cd \/opt\/founderos && bash deploy\/sync-daemons\.sh)'/.exec(ssh)?.[1] ?? "";
    expect(remote).toBe("cd /opt/founderos && bash deploy/sync-daemons.sh");
    expect(remote).not.toMatch(/\$|`/);
  });

  it("no step turns on shell tracing or dumps the environment", () => {
    for (const s of all) {
      const script = code(s.run).join("\n");
      expect(script, s.name).not.toMatch(/set\s+-[a-z]*x|xtrace/);
      expect(script, s.name).not.toMatch(/\b(printenv)\b|(^|[;&|]\s*)env\s*($|[;&|])/m);
    }
  });
});

describe("deploy.yml — the existing deploy step keeps its secrets-via-stdin contract", () => {
  it("still sends PROD_DOTENV and the API keys as base64 on stdin, and never as `envs:`", () => {
    expect(deployStep?.run).toContain("emit PROD_DOTENV");
    expect(deployStep?.run).toContain("emit GOOGLE_GENERATIVE_AI_API_KEY");
    expect(deployStep?.run).toMatch(/\| timeout 10m ssh/);
    // Active lines only: a comment may explain that the step USED appleboy/ssh-action with `envs:`
    // until 2026-08-12 (it does, on main). What must never come back is a line that does.
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
