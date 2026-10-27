/**
 * deploy/deploy.sh — the founderos-hub-http restart.
 * The unit file is root-only (mode 600), so the old guard `systemctl cat founderos-hub-http` failed for the deploy
 * user and the hub silently never restarted: prod ran a 2026-10-12 hub through every deploy until 2026-10-27, and new
 * brain tools (recent_memories) never went live. The test runs the real line with stub `systemctl` and `sudo`.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY_SH = readFileSync(fileURLToPath(new URL("../../../deploy/deploy.sh", import.meta.url)), "utf8");
const HUB_LINE = DEPLOY_SH.split("\n").find((l) => l.includes("restart founderos-hub-http")) ?? "";

function run(unitInstalled: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-restart-"));
  try {
    const log = join(dir, "sudo.log");
    // Non-root systemctl: `cat` of a 600 unit is refused; list-unit-files works without reading the file.
    writeFileSync(join(dir, "systemctl"), `#!/bin/sh
case "$1" in
  cat) echo "Permission denied" >&2; exit 1 ;;
  list-unit-files) ${unitInstalled ? 'echo "founderos-hub-http.service enabled enabled"' : ":"}; exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(dir, "sudo"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
    chmodSync(join(dir, "systemctl"), 0o755);
    chmodSync(join(dir, "sudo"), 0o755);
    writeFileSync(log, "");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${HUB_LINE}`], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    return readFileSync(log, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("deploy.sh hub restart", () => {
  it("restarts the hub when the unit is installed but its file is root-only", () => {
    expect(run(true)).toContain("systemctl restart founderos-hub-http");
  });
  it("skips the restart when the unit is not installed", () => {
    expect(run(false)).toBe("");
  });
});
