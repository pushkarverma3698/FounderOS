/**
 * deploy/oracle-report.sh: the thin wrapper the Deploy workflow runs on the VPS.
 * It reads five keys from .env without sourcing it, passes the deployed commit, and always exits 0.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../deploy/oracle-report.sh", import.meta.url));
let root: string;
let head: string;

function run(envText: string, extra: Record<string, string> = {}): { out: string; status: number | null } {
  writeFileSync(join(root, ".env"), envText);
  const r = spawnSync("bash", [SCRIPT], {
    env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: root, ORACLE_REPORT_ROOT: root, ORACLE_REPORT_NODE: join(root, "fakenode"), ...extra },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { out: r.stdout, status: r.status };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oracle-wrap-"));
  mkdirSync(join(root, "scripts"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: root });
  head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(join(root, "fakenode"), `#!/usr/bin/env bash\n{ echo "ARGS $*"; env | grep -E '^(AGENT_PIPELINE_V2|FOUNDEROS_CONTRACTS_DIR|ORACLE_ALLOWED_HOSTS|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|ORACLE_REPORT_REPO|EVIL)=' | sort; } >"${root}/seen.txt"\necho '{"status":"OK","checked":0,"sent":false}'\n[ -z "$FAKE_FAIL" ] || exit 3\n`);
  chmodSync(join(root, "fakenode"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("deploy/oracle-report.sh", () => {
  it("passes the deployed commit and exactly the five keys it needs, quotes stripped", () => {
    const r = run(`AGENT_PIPELINE_V2="1"\nFOUNDEROS_CONTRACTS_DIR=/var/c\nORACLE_ALLOWED_HOSTS='a.example.com,b.example.com'\nTELEGRAM_BOT_TOKEN=tok\nTELEGRAM_CHAT_ID=42\nEVIL=nope\n`);
    const seen = readFileSync(join(root, "seen.txt"), "utf8");
    expect(r.status).toBe(0);
    expect(r.out).toContain('"status":"OK"');
    expect(seen).toContain(`ARGS --import tsx/esm scripts/oracle-report.ts --deployed ${head}`);
    expect(seen).toContain("AGENT_PIPELINE_V2=1");
    expect(seen).toContain("FOUNDEROS_CONTRACTS_DIR=/var/c");
    expect(seen).toContain("ORACLE_ALLOWED_HOSTS=a.example.com,b.example.com");
    expect(seen).toContain("TELEGRAM_CHAT_ID=42");
    expect(seen).not.toContain("EVIL");
  });

  it("does not execute the .env (a value with shell syntax stays text)", () => {
    run(`ORACLE_ALLOWED_HOSTS=$(touch ${join(root, "pwned")})\n`);
    expect(existsSync(join(root, "pwned"))).toBe(false);
  });

  it("a value already in the environment wins over .env", () => {
    run("AGENT_PIPELINE_V2=0\n", { AGENT_PIPELINE_V2: "1" });
    expect(readFileSync(join(root, "seen.txt"), "utf8")).toContain("AGENT_PIPELINE_V2=1");
  });

  it("exits 0 and says so when the script fails", () => {
    const r = run("AGENT_PIPELINE_V2=1\n", { FAKE_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("the report script exited non-zero");
  });

  it("exits 0 and says so when it cannot read the deployed commit", () => {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    const r = run("AGENT_PIPELINE_V2=1\n");
    expect(r.status).toBe(0);
    expect(r.out).toContain("could not read the deployed commit");
  });
});
