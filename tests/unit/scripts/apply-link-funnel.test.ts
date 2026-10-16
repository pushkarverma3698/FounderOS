/**
 * Funnel publisher contract — scripts/infra/apply-link-funnel.sh.
 * ================================================================
 * The founder opens the apply link from a phone, so the jobs bot's /apply route must be on public HTTPS
 * after every deploy with nobody touching it. deploy/deploy.sh runs this script each time, so it has to
 * be idempotent (a re-run changes nothing), touch only its own mount, and fail loudly and non-zero.
 *
 * These run the REAL script with `tailscale` and `sudo` replaced by stubs on PATH, so nothing here talks
 * to a tailnet. The stub serves canned `status --json` / `serve status --json` output, records every call,
 * and on `funnel ...` swaps in a canned "after" serve config (or fails). The JSON shapes are copied from
 * tailscale 1.104.1 on the production VPS, 2026-10-16.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/infra/apply-link-funnel.sh", import.meta.url));

const HOST = "turicks-dots.taile5afc3.ts.net";
const HOSTPORT = `${HOST}:443`;
const TARGET = "http://127.0.0.1:3001/apply";
const FUNNEL_ARGS = `funnel --yes --bg --https=443 --set-path=/apply ${TARGET}`;

const STATUS_OK = {
  BackendState: "Running",
  Self: {
    DNSName: `${HOST}.`,
    CapMap: {
      funnel: null,
      https: null,
      "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000": null,
    },
  },
};

const mapped = (extra: Record<string, unknown> = {}, proxy = TARGET, funnel = true) => ({
  TCP: { "443": { HTTPS: true } },
  Web: { [HOSTPORT]: { Handlers: { "/apply": { Proxy: proxy }, ...extra } } },
  ...(funnel ? { AllowFunnel: { [HOSTPORT]: true } } : {}),
});

const STUB_TAILSCALE = `#!/bin/sh
d="$FAKE_TS_DIR"
echo "$*" >> "$d/calls.log"
case "$1" in
  status) cat "$d/status.json" ;;
  serve) cat "$d/serve.json" ;;
  funnel)
    if [ -f "$d/funnel.fail" ]; then echo "funnel boom: access denied" >&2; exit 1; fi
    cp "$d/serve.after.json" "$d/serve.json" ;;
  *) echo "unexpected tailscale call: $*" >&2; exit 2 ;;
esac
`;

// Mirrors how the deploy user runs it (`sudo -n tailscale ...`): drop the flag and exec the rest.
const STUB_SUDO = `#!/bin/sh
if [ "$1" = "-n" ]; then shift; fi
exec "$@"
`;

interface Scenario {
  status?: unknown;
  serve?: unknown;
  /** What `serve status --json` returns once `funnel ...` succeeded. Defaults to the correct mapping. */
  after?: unknown;
  funnelFails?: boolean;
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Every tailscale invocation, one line each. */
  calls: string[];
  /** The mutating ones only. */
  funnelCalls: string[];
}

function run(s: Scenario, args: string[] = [], opts: { noTailscale?: boolean } = {}): Ran {
  const dir = mkdtempSync(join(tmpdir(), "apply-link-funnel-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  for (const d of [bin, state]) mkdirSync(d, { recursive: true });
  const put = (name: string, body: string, to = state) => writeFileSync(join(to, name), body);
  put("status.json", JSON.stringify(s.status ?? STATUS_OK));
  put("serve.json", JSON.stringify(s.serve ?? {}));
  put("serve.after.json", JSON.stringify(s.after ?? mapped()));
  put("calls.log", "");
  if (s.funnelFails) put("funnel.fail", "1");
  if (!opts.noTailscale) {
    put("tailscale", STUB_TAILSCALE, bin);
    chmodSync(join(bin, "tailscale"), 0o755);
  }
  put("sudo", STUB_SUDO, bin);
  chmodSync(join(bin, "sudo"), 0o755);

  // The real PATH stays behind the stubs: the script needs python3, tr and friends.
  const PATH = opts.noTailscale ? bin : `${bin}:${process.env["PATH"] ?? ""}`;
  const r = spawnSync("/bin/bash", [SCRIPT, ...args], {
    env: { PATH, FAKE_TS_DIR: state },
    encoding: "utf8",
  });
  const calls = readFileSync(join(state, "calls.log"), "utf8").split("\n").filter(Boolean);
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls,
    funnelCalls: calls.filter((c) => c.startsWith("funnel")),
  };
}

describe("apply-link-funnel.sh — publishing", () => {
  it("on a fresh node: runs the one funnel command that was proven on the VPS, then prints the public base URL", () => {
    const r = run({ serve: {} });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(`https://${HOST}`);
    // --set-path strips the mount before proxying, so the target repeats /apply: the app must see /apply/<token>.
    expect(r.funnelCalls).toEqual([FUNNEL_ARGS]);
  });

  it("is idempotent: with the mapping already correct it changes nothing and still exits 0 with the URL", () => {
    const r = run({ serve: mapped() });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(`https://${HOST}`);
    expect(r.funnelCalls, "no mutation on a correct mapping").toEqual([]);
    expect(r.stderr).toContain("no change");
  });

  it("repairs a mapping that points at the wrong target", () => {
    const r = run({ serve: mapped({}, "http://127.0.0.1:9999/apply") });
    expect(r.code, r.stderr).toBe(0);
    expect(r.funnelCalls).toEqual([FUNNEL_ARGS]);
  });

  it("repairs a correct mapping whose Funnel switch is off", () => {
    const r = run({ serve: mapped({}, TARGET, false) });
    expect(r.code, r.stderr).toBe(0);
    expect(r.funnelCalls).toEqual([FUNNEL_ARGS]);
  });

  it("never resets: no call other than status, serve status and the one funnel set", () => {
    const r = run({ serve: {} });
    for (const c of r.calls) expect(c, `unexpected call: ${c}`).toMatch(/^(status |serve status |funnel --yes )/);
    expect(r.calls.join("\n")).not.toMatch(/reset/);
  });

  it("refuses to switch Funnel on while another tailnet-only handler shares the port (Funnel is per host:port)", () => {
    const r = run({ serve: mapped({ "/admin": { Proxy: "http://127.0.0.1:8080" } }, "http://127.0.0.1:9999/apply", false) });
    expect(r.code).toBe(1);
    expect(r.funnelCalls, "nothing was published").toEqual([]);
    expect(r.stderr).toContain("/admin");
    expect(r.stderr).toContain("publish");
  });

  it("goes ahead when Funnel is already on for the port: the other handler is public already", () => {
    const r = run({ serve: mapped({ "/other": { Proxy: "http://127.0.0.1:8080" } }, "http://127.0.0.1:9999/apply", true) });
    expect(r.code, r.stderr).toBe(0);
    expect(r.funnelCalls).toEqual([FUNNEL_ARGS]);
  });
});

describe("apply-link-funnel.sh — --print-base-url", () => {
  it("prints https://<DNSName> without the trailing dot and touches nothing", () => {
    const r = run({}, ["--print-base-url"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`https://${HOST}\n`);
    expect(r.calls.every((c) => c.startsWith("status "))).toBe(true);
    expect(r.funnelCalls).toEqual([]);
  });

  it("works without the funnel capability: it only needs a running node with a DNS name", () => {
    const r = run({ status: { BackendState: "Running", Self: { DNSName: `${HOST}.`, CapMap: {} } } }, ["--print-base-url"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(`https://${HOST}`);
  });
});

describe("apply-link-funnel.sh — failures are loud and non-zero", () => {
  it("fails when the tailscale binary is missing", () => {
    const r = run({}, [], { noTailscale: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("tailscale binary not found");
    expect(r.stdout).toBe("");
  });

  it("fails when the node has no funnel capability, before changing anything", () => {
    const r = run({ status: { BackendState: "Running", Self: { DNSName: `${HOST}.`, CapMap: { https: null } } } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("funnel");
    expect(r.funnelCalls).toEqual([]);
  });

  it("fails when HTTPS certificates are not enabled", () => {
    const r = run({ status: { BackendState: "Running", Self: { DNSName: `${HOST}.`, CapMap: { funnel: null } } } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HTTPS");
    expect(r.funnelCalls).toEqual([]);
  });

  it("fails when Funnel is not allowed on port 443 for this node", () => {
    const r = run({
      status: {
        BackendState: "Running",
        Self: { DNSName: `${HOST}.`, CapMap: { funnel: null, https: null, "https://tailscale.com/cap/funnel-ports?ports=8443,10000": null } },
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("port 443");
    expect(r.funnelCalls).toEqual([]);
  });

  it("fails when tailscale is not running", () => {
    const r = run({ status: { BackendState: "Stopped", Self: { DNSName: `${HOST}.`, CapMap: {} } } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not running");
    expect(r.funnelCalls).toEqual([]);
  });

  it("fails and shows the CLI message when `tailscale funnel` itself fails", () => {
    const r = run({ funnelFails: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("tailscale funnel failed");
    expect(r.stderr).toContain("funnel boom: access denied");
    expect(r.stdout, "no URL is printed for an unpublished route").toBe("");
  });

  it("fails when the funnel command returns 0 but the mapping is not there afterwards", () => {
    const r = run({ after: {} });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not mapped");
  });

  it("rejects an unknown argument", () => {
    const r = run({}, ["--wipe"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown argument");
    expect(r.calls).toEqual([]);
  });
});

describe("apply-link-funnel.sh — wiring", () => {
  it("is executable, so deploy.sh and the README can call it directly", () => {
    expect(() => accessSync(SCRIPT, constants.X_OK)).not.toThrow();
  });

  it("deploy.sh runs it after the health check, bounded, and never lets a failure turn the deploy red", () => {
    const deploy = readFileSync(fileURLToPath(new URL("../../../deploy/deploy.sh", import.meta.url)), "utf8");
    const health = deploy.indexOf("Deploy OK");
    const hook = deploy.indexOf("scripts/infra/apply-link-funnel.sh");
    expect(health).toBeGreaterThan(-1);
    expect(hook, "deploy.sh does not call the funnel script").toBeGreaterThan(health);
    const line = deploy.split("\n").find((l) => l.includes("bash scripts/infra/apply-link-funnel.sh") && l.startsWith("if "));
    expect(line, "the call must sit in an `if !` so set -e cannot abort the deploy").toMatch(/^if ! \$FUNNEL_TMO bash scripts\/infra\/apply-link-funnel\.sh <\/dev\/null; then$/);
    expect(deploy).toContain('FUNNEL_TMO="timeout 90"');
    expect(deploy).toContain("APPLY_LINK_FUNNEL_FAILED");
  });
});
