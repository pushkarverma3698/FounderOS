/**
 * deploy/deploy.sh — the two health probes that used to be `<command> | grep -q`.
 * ================================================================================
 * deploy.sh runs under `set -euo pipefail`. With `producer | grep -q PATTERN`, grep exits on its first hit, the
 * producer takes SIGPIPE (status 141), and pipefail turns that into "no match" for a line that IS there. A producer
 * that writes more than the 64 KB pipe buffer (a web page) makes it certain; a small one makes it a rare flake
 * (about 0.2% of lookups on bash 5.2 under CPU load; the onboard-repo.sh label check failed in CI that way).
 *
 * deploy.sh cannot be run whole here (it cd's to /opt/founderos, restarts systemd, runs migrations), so each test
 * cuts the real block out of the file and runs it in bash under the script's own options, with stub `docker` and
 * `curl` on PATH. The stubs write far more than 64 KB, which makes the old form fail every time, not one run in 500.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY_SH = readFileSync(fileURLToPath(new URL("../../../deploy/deploy.sh", import.meta.url)), "utf8");

/** From the first line that matches `start` through the next line that is exactly `fi`. */
function block(start: RegExp): string {
  const lines = DEPLOY_SH.split("\n");
  const from = lines.findIndex((l) => start.test(l));
  expect(from, `deploy.sh no longer has a line matching ${start}`).toBeGreaterThan(-1);
  const to = lines.findIndex((l, i) => i > from && l === "fi");
  expect(to, `no closing \`fi\` after the line matching ${start}`).toBeGreaterThan(from);
  return lines.slice(from, to + 1).join("\n");
}

// The Ollama check starts at its `if !`, or at the capture line that precedes it. Either way it ends at the first `fi`.
const OLLAMA = block(/docker ps --filter "name=founderos-ollama"/);
// The SPA check: the first line that fetches `/` of the web gateway (not /api/v1/health), through its `fi`.
const SPA = block(/curl -fsS http:\/\/127\.0\.0\.1:3001\/(\s|\))/);

const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$1" in
  ps)
    case "$DOCKER_PS" in
      one)  echo abc123def456 ;;
      none) : ;;
      fail) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;
      many) awk 'BEGIN { for (i = 0; i < 200000; i++) print "abc123def456" }' ;;
    esac ;;
  start) exit "\${DOCKER_START_RC:-0}" ;;
esac
`;

const CURL_STUB = `#!/bin/sh
echo "curl $*" >> "$STUB_LOG"
case "$CURL_MODE" in
  small)   echo '<!doctype html><title>JARVIS</title><div id="root"></div>' ;;
  big)     awk 'BEGIN { print "<!doctype html><title>JARVIS</title>"; for (i = 0; i < 60000; i++) print "padding padding padding" }' ;;
  nomatch) echo 'plain text, nothing to see' ;;
  empty)   : ;;
  die)     echo "curl: (22) The requested URL returned error: 404" >&2; exit 22 ;;
  partial) echo '<!doctype html><title>JARVIS</title>'; echo "curl: (23) Failure writing output to destination" >&2; exit 23 ;;
esac
`;

let dir: string;
let bin: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deploy-sh-pipefail-"));
  bin = join(dir, "bin");
  log = join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  for (const [name, body] of [
    ["docker", DOCKER_STUB],
    ["curl", CURL_STUB],
  ] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Ran {
  status: number | null;
  out: string;
  err: string;
  calls: string[];
}

/** Run a block of deploy.sh under the script's own shell options, with the stubs first on PATH. */
function run(script: string, env: Record<string, string>): Ran {
  const r = spawnSync("bash", ["-c", `set -euo pipefail\n${script}\necho "reached-end"`], {
    env: { PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: log, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { status: r.status, out: r.stdout, err: r.stderr, calls };
}

const started = (calls: string[]): boolean => calls.some((c) => c.startsWith("docker start"));

describe("deploy.sh runs under set -euo pipefail (the condition these tests rely on)", () => {
  it("still sets it", () => {
    expect(DEPLOY_SH).toMatch(/^set -euo pipefail$/m);
  });
});

describe("deploy.sh — Ollama running check", () => {
  it("a running container is found however much `docker ps` prints: grep's first hit is not 'not running'", () => {
    const r = run(OLLAMA, { DOCKER_PS: "many" });
    expect(r.status, r.err).toBe(0);
    expect(started(r.calls), `docker start was called on a running container: ${r.calls.join(" | ")}`).toBe(false);
    expect(r.out).not.toContain("not running");
  });

  it("a running container is left alone", () => {
    const r = run(OLLAMA, { DOCKER_PS: "one" });
    expect(r.status, r.err).toBe(0);
    expect(started(r.calls)).toBe(false);
  });

  it("no running container: starts it", () => {
    const r = run(OLLAMA, { DOCKER_PS: "none" });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("founderos-ollama not running");
    expect(r.calls).toContain("docker start founderos-ollama");
  });

  it("`docker ps` itself failing counts as not running, and does not abort the deploy", () => {
    const r = run(OLLAMA, { DOCKER_PS: "fail" });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toContain("docker start founderos-ollama");
    expect(r.out).toContain("reached-end");
  });

  it("when `docker start` fails, falls back to compose up", () => {
    const r = run(OLLAMA, { DOCKER_PS: "none", DOCKER_START_RC: "1" });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toContain("docker compose -f deploy/stack.compose.yml up -d ollama");
  });
});

describe("deploy.sh — JARVIS UI check on GET /", () => {
  it("a healthy page is recognised however big it is: curl writing past grep's first hit is not a failed check", () => {
    const r = run(SPA, { CURL_MODE: "big" });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("JARVIS UI OK");
    expect(r.err).not.toContain("web SPA removed");
  });

  it("a small healthy page is recognised", () => {
    const r = run(SPA, { CURL_MODE: "small" });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("JARVIS UI OK");
    expect(r.err).not.toContain("web SPA removed");
  });

  it("a page with none of the markers reports the same message as before, and does not abort", () => {
    for (const mode of ["nomatch", "empty"]) {
      const r = run(SPA, { CURL_MODE: mode });
      expect(r.status, `${mode}: ${r.err}`).toBe(0);
      expect(r.out, mode).not.toContain("JARVIS UI OK");
      expect(r.err, mode).toContain("(v3: web SPA removed — health endpoint only)");
      expect(r.out, mode).toContain("reached-end");
    }
  });

  it("curl failing is a failed check, with curl's own error still on stderr, and does not abort", () => {
    const r = run(SPA, { CURL_MODE: "die" });
    expect(r.status, r.err).toBe(0);
    expect(r.out).not.toContain("JARVIS UI OK");
    expect(r.err).toContain("curl: (22)");
    expect(r.err).toContain("(v3: web SPA removed — health endpoint only)");
  });

  it("curl failing after it printed a matching page is still a failed check: a real failure is not masked", () => {
    const r = run(SPA, { CURL_MODE: "partial" });
    expect(r.status, r.err).toBe(0);
    expect(r.out).not.toContain("JARVIS UI OK");
    expect(r.err).toContain("(v3: web SPA removed — health endpoint only)");
  });
});

describe("deploy.sh: built app readable by the agy-login helper", () => {
  it("makes dist world-readable right after the build, before anything restarts", () => {
    const build = DEPLOY_SH.indexOf("pnpm build:all");
    const chmod = DEPLOY_SH.indexOf("find dist -user");
    expect(build).toBeGreaterThan(-1);
    expect(chmod).toBeGreaterThan(build);
    expect(DEPLOY_SH).toContain("-exec chmod a+rX {} +");
    expect(chmod).toBeLessThan(DEPLOY_SH.indexOf("docker compose -f deploy/stack.compose.yml up -d"));
  });
});
