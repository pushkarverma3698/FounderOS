/**
 * The daemons deploy with the app — deploy/sync-daemons.sh.
 * ==========================================================
 * The daemons run from ~/bin, outside the app checkout. Until this step existed a merge changed
 * nothing on the VPS until somebody copied the files by hand, and nothing checked that anyone
 * had. That is a pipeline change: a bug in it turns EVERY deploy red, so the copy-and-verify
 * logic lives in a script that runs here against a fake HOME and a real sha256sum, and the
 * workflow YAML stays thin (see deploy-workflow.test.ts).
 *
 * The failure this file exists to prevent: the daemons now source helper files
 * (deploy/lib/*.sh). If the deploy copied the daemons and not the helpers, the FIRST deploy
 * would break both of them at once. So the test that matters most is the last describe: every
 * file a daemon sources is in the copy list, found by tracing what the daemon actually sources.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY = fileURLToPath(new URL("../../../deploy/", import.meta.url));
const SYNC = join(DEPLOY, "sync-daemons.sh");
const EXECUTABLES = ["agent-dispatch", "pr-brain", "onboard-repo.sh"] as const;
/** Where each executable lives in the repo, relative to deploy/. */
const SOURCE_OF: Record<(typeof EXECUTABLES)[number], string> = {
  "agent-dispatch": "agent-dispatch",
  "pr-brain": "vps-daemons/pr-brain",
  "onboard-repo.sh": "onboard-repo.sh",
};

let root: string;
let home: string;
let bin: string;
const libNames = readdirSync(join(DEPLOY, "lib")).filter((n) => n.endsWith(".sh"));

/** A real sha256sum (the script uses the same tool). */
function sha(file: string): string {
  const r = spawnSync("sha256sum", [file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sha256sum ${file}: ${r.stderr}`);
  return r.stdout.split(" ")[0] ?? "";
}

interface Ran {
  status: number | null;
  out: string;
  err: string;
}

function sync(env: Record<string, string> = {}, path = "/usr/bin:/bin"): Ran {
  const r = spawnSync("bash", [SYNC], {
    env: { PATH: path, HOME: home, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** A private copy of deploy/ that a test may break, addressed through SYNC_DAEMONS_SRC. */
function copyOfDeploy(): string {
  const dir = join(root, "src-deploy");
  cpSync(DEPLOY, dir, { recursive: true });
  return dir;
}

/**
 * Shims for cp/chmod/mv that log every call and then run the real tool, so a test can assert on
 * ORDER (cp to .new, chmod, mv over the target) and can corrupt one copy on purpose.
 */
function shimTools(): { path: string; log: () => string[] } {
  const dir = join(root, "shims");
  mkdirSync(dir, { recursive: true });
  const logFile = join(root, "shim.log");
  for (const tool of ["cp", "chmod", "mv"]) {
    const real = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout.trim();
    writeFileSync(
      join(dir, tool),
      `#!/bin/bash
printf '%s\\n' "${tool} $*" >>"${logFile}"
if [ "${tool}" = cp ] && [ -n "\${SHIM_CORRUPT:-}" ] && [ "\${@: -1}" = "\${SHIM_CORRUPT}.new" ]; then
  head -c 200 "$1" >"\${@: -1}"; exit 0
fi
if [ "${tool}" = chmod ] && [ -n "\${SHIM_NO_CHMOD:-}" ]; then exit 0; fi
exec ${real} "$@"
`,
      { mode: 0o755 },
    );
  }
  return {
    path: `${dir}:/usr/bin:/bin`,
    log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []),
  };
}

const modeOf = (p: string) => (statSync(p).mode & 0o777).toString(8);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-daemons-"));
  home = join(root, "home");
  bin = join(home, "bin");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sync-daemons.sh — what it installs", () => {
  it("copies every daemon and every helper into ~/bin, byte for byte (real sha256sum), and exits 0", () => {
    const r = sync();

    expect(r.status, r.err).toBe(0);
    for (const name of EXECUTABLES) {
      expect(sha(join(bin, name)), name).toBe(sha(join(DEPLOY, SOURCE_OF[name])));
    }
    expect(libNames.length).toBeGreaterThan(0);
    for (const lib of libNames) expect(sha(join(bin, "lib", lib)), lib).toBe(sha(join(DEPLOY, "lib", lib)));
    expect(r.out).toMatch(/every sha256 matches the checkout/);
  });

  it("makes the daemons executable and leaves the sourced helpers non-executable", () => {
    sync();
    for (const name of EXECUTABLES) expect(modeOf(join(bin, name)), name).toBe("755");
    for (const lib of libNames) expect(modeOf(join(bin, "lib", lib)), lib).toBe("644");
  });

  it("prints one line per installed file with its short sha256, so the Actions log shows what shipped", () => {
    const r = sync();
    for (const name of EXECUTABLES) expect(r.out).toMatch(new RegExp(`sync-daemons: ok  [0-9a-f]{12}  .*/${name.replace(".", "\\.")}$`, "m"));
    for (const lib of libNames) expect(r.out).toContain(`/lib/${lib}`);
  });

  it("is idempotent: a second run succeeds and changes nothing", () => {
    sync();
    const before = [...EXECUTABLES.map((n) => sha(join(bin, n))), ...libNames.map((l) => sha(join(bin, "lib", l)))];
    const second = sync();

    expect(second.status, second.err).toBe(0);
    expect([...EXECUTABLES.map((n) => sha(join(bin, n))), ...libNames.map((l) => sha(join(bin, "lib", l)))]).toEqual(before);
  });

  it("replaces a stale or hand-edited copy on the box with the checkout's", () => {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "agent-dispatch"), "#!/bin/bash\necho hand-edited on the VPS\n", { mode: 0o755 });
    sync();
    expect(sha(join(bin, "agent-dispatch"))).toBe(sha(join(DEPLOY, "agent-dispatch")));
  });

  it("honours SYNC_DAEMONS_DEST", () => {
    const dest = join(root, "elsewhere");
    const r = sync({ SYNC_DAEMONS_DEST: dest });
    expect(r.status, r.err).toBe(0);
    expect(existsSync(join(dest, "agent-dispatch"))).toBe(true);
    expect(existsSync(bin)).toBe(false);
  });
});

describe("sync-daemons.sh — atomic, and in the right order", () => {
  it("writes <name>.new, sets its mode, then mv -f's it over the target: never a half-written daemon", () => {
    const shims = shimTools();
    const r = sync({}, shims.path);
    expect(r.status, r.err).toBe(0);

    const log = shims.log();
    for (const name of EXECUTABLES) {
      const dst = join(bin, name);
      const cp = log.findIndex((l) => l.startsWith("cp ") && l.endsWith(`${dst}.new`));
      const chmod = log.findIndex((l) => l.startsWith("chmod ") && l.endsWith(`${dst}.new`));
      const mv = log.findIndex((l) => l === `mv -f ${dst}.new ${dst}`);
      expect([cp, chmod, mv].every((i) => i >= 0), `${name}: ${JSON.stringify(log.filter((l) => l.includes(name)))}`).toBe(true);
      expect(cp).toBeLessThan(chmod);
      expect(chmod).toBeLessThan(mv);
    }
  });

  it("leaves no .new file behind", () => {
    sync();
    const leftovers = [
      ...readdirSync(bin).filter((n) => n.endsWith(".new")),
      ...readdirSync(join(bin, "lib")).filter((n) => n.endsWith(".new")),
    ];
    expect(leftovers).toEqual([]);
  });

  it("installs every helper BEFORE any daemon, so a daemon that starts mid-sync never lacks its helpers", () => {
    const shims = shimTools();
    sync({}, shims.path);

    const moves = shims.log().filter((l) => l.startsWith("mv -f "));
    const lastLib = Math.max(...moves.map((l, i) => (l.includes("/lib/") ? i : -1)));
    const firstDaemon = moves.findIndex((l) => !l.includes("/lib/"));
    expect(lastLib).toBeGreaterThanOrEqual(0);
    expect(firstDaemon).toBeGreaterThan(lastLib);
  });
});

describe("sync-daemons.sh — it verifies, and a failure names the file", () => {
  it("catches a copy that does not match the checkout and names the file, both hashes and exits 1", () => {
    const shims = shimTools();
    const r = sync({ SHIM_CORRUPT: join(bin, "agent-dispatch") }, shims.path);

    expect(r.status).toBe(1);
    expect(r.err).toMatch(/MISMATCH: .*\/agent-dispatch differs from .*\/deploy\/agent-dispatch \(checkout sha256 [0-9a-f]{64}, deployed [0-9a-f]{64}\)/);
    expect(r.err).toMatch(/FAILED/);
    // the healthy files are still reported ok: the log says exactly which one is wrong
    expect(r.out).toMatch(/ok  [0-9a-f]{12}  .*\/pr-brain/);
    expect(r.out).not.toMatch(/ok  [0-9a-f]{12}  .*\/agent-dispatch$/m);
  });

  it("catches a daemon that ended up not executable and names it", () => {
    const src = copyOfDeploy();
    chmodSync(join(src, "agent-dispatch"), 0o644);
    const shims = shimTools();
    const r = sync({ SYNC_DAEMONS_SRC: src, SHIM_NO_CHMOD: "1" }, shims.path);

    expect(r.status).toBe(1);
    expect(r.err).toMatch(/MISMATCH: .*\/agent-dispatch is not executable/);
  });

  it("copies NOTHING when a source file is missing, and names it", () => {
    const src = copyOfDeploy();
    rmSync(join(src, "onboard-repo.sh"));
    const r = sync({ SYNC_DAEMONS_SRC: src });

    expect(r.status).toBe(1);
    expect(r.err).toMatch(/FAILED: .*onboard-repo\.sh is missing or empty/);
    expect(existsSync(bin)).toBe(false);
  });

  it("copies NOTHING when a source has a syntax error: it must not ship to a daemon that runs unattended", () => {
    const src = copyOfDeploy();
    writeFileSync(join(src, "vps-daemons", "pr-brain"), "#!/usr/bin/env bash\nif then fi (\n");
    const r = sync({ SYNC_DAEMONS_SRC: src });

    expect(r.status).toBe(1);
    expect(r.err).toMatch(/pr-brain does not pass bash -n/);
    expect(existsSync(bin)).toBe(false);
  });

  it("refuses when there are no helpers to ship at all", () => {
    const src = copyOfDeploy();
    rmSync(join(src, "lib"), { recursive: true });
    const r = sync({ SYNC_DAEMONS_SRC: src });

    expect(r.status).toBe(1);
    expect(r.err).toMatch(/no lib\/\*\.sh/);
    expect(existsSync(bin)).toBe(false);
  });

  it("fails the sync when an installed daemon cannot find a helper it sources, naming the daemon and the helper", () => {
    // The copy list is a glob over lib/, so to reproduce "a sourced file was not shipped" the
    // source tree simply lacks one helper the daemon needs while others exist.
    const src = copyOfDeploy();
    rmSync(join(src, "lib", "agy-failure.sh"));
    const r = sync({ SYNC_DAEMONS_SRC: src });

    expect(r.status).toBe(1);
    expect(r.err).toMatch(/agent-dispatch --help exited non-zero/);
    expect(r.err).toContain("agy-failure.sh");
  });
});

describe("the deployed daemons find their helpers from their own REAL path", () => {
  it("works through a symlink from another directory (readlink -f), for all three daemons", () => {
    sync();
    const links = join(root, "links");
    mkdirSync(links, { recursive: true });
    for (const name of EXECUTABLES) {
      symlinkSync(join(bin, name), join(links, name));
      const r = spawnSync("bash", [join(links, name), "--help"], {
        cwd: links,
        env: { PATH: "/usr/bin:/bin", HOME: home, PR_BRAIN_OWNER: "smoke" },
        encoding: "utf8",
      });
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it("a daemon with its helper directory removed refuses to start, loudly, and says how to fix it", () => {
    sync();
    rmSync(join(bin, "lib"), { recursive: true });
    for (const name of ["agent-dispatch", "pr-brain"] as const) {
      const r = spawnSync("bash", [join(bin, name), "--help"], {
        env: { PATH: "/usr/bin:/bin", HOME: home, PR_BRAIN_OWNER: "smoke" },
        encoding: "utf8",
      });
      expect(r.status, name).toBe(1);
      expect(r.stdout).toMatch(/FATAL: lib\/.*\.sh not found/);
      expect(r.stdout).toMatch(/sync-daemons/);
    }
  });
});

describe("every file a deployed daemon sources is in the deploy copy list", () => {
  /** What the script actually sources when it starts, found by tracing it. */
  function sourcedBy(script: string): string[] {
    const r = spawnSync("bash", ["-x", script, "--help"], {
      env: { PATH: "/usr/bin:/bin", HOME: home, PR_BRAIN_OWNER: "smoke" },
      encoding: "utf8",
    });
    // pr-brain sources deploy/vps-daemons/../lib/x.sh in the repo layout: compare real locations.
    return [...r.stderr.matchAll(/^\++ (?:source|\.) (\S+)$/gm)].map((m) => resolve(m[1] as string));
  }

  it("agent-dispatch and pr-brain each source at least one helper, all of them under deploy/lib", () => {
    for (const name of ["agent-dispatch", "vps-daemons/pr-brain"]) {
      const sourced = sourcedBy(join(DEPLOY, name));
      expect(sourced.length, `${name} sources nothing: the trace found no 'source' line`).toBeGreaterThan(0);
      for (const file of sourced) expect(file, `${name} sources ${file}`).toMatch(/\/deploy\/lib\/[^/]+\.sh$/);
    }
  });

  it("every helper a daemon sources, and every helper in deploy/lib, is installed by the sync with the same bytes", () => {
    sync();
    const sourced = new Set([
      ...sourcedBy(join(DEPLOY, "agent-dispatch")),
      ...sourcedBy(join(DEPLOY, "vps-daemons/pr-brain")),
      ...sourcedBy(join(DEPLOY, "onboard-repo.sh")),
    ]);
    expect(sourced.size).toBeGreaterThan(0);
    for (const file of sourced) {
      const deployed = join(bin, "lib", file.split("/").pop() ?? "");
      expect(existsSync(deployed), `${file} is sourced by a daemon but sync-daemons.sh did not install it`).toBe(true);
      expect(sha(deployed)).toBe(sha(file));
    }
    expect(readdirSync(join(bin, "lib")).sort()).toEqual([...libNames].sort());
  });

  it("no daemon sources a file from anywhere but lib/ (an absolute path would not exist on the VPS)", () => {
    for (const name of ["agent-dispatch", "vps-daemons/pr-brain", "onboard-repo.sh"]) {
      const text = readFileSync(join(DEPLOY, name), "utf8");
      const literal = [...text.matchAll(/^\s*(?:source|\.)\s+(["']?)(\/[^\s"']+)\1/gm)].map((m) => m[2]);
      expect(literal, `${name} sources an absolute path`).toEqual([]);
    }
  });

  it("the copy list names every executable the crontab or a daemon calls", () => {
    const text = readFileSync(SYNC, "utf8");
    for (const name of EXECUTABLES) expect(text, `${name} is not in sync-daemons.sh`).toContain(SOURCE_OF[name]);
    expect(text).toMatch(/lib\/\*\.sh/);
  });
});

describe("sync-daemons.sh — the per-minute kick cron", () => {
  // What the box really has (crontab -l on founderos-vps, 2026-10-02), the lines that matter.
  const AGENT_LINE =
    "*/15 * * * * PATH=/usr/local/bin:/usr/bin:/bin AGENT_DISPATCH_ENV_FILE=/opt/founderos/.env $HOME/bin/agent-dispatch >/dev/null 2>>$HOME/.claude/agent-dispatch.log";
  const OTHER_LINES = [
    "*/2 * * * * $HOME/bin/founderos-watchdog.sh >> /tmp/founderos-watchdog.log 2>&1",
    "17 3 * * * BACKUP_DIR=$HOME/backups /opt/founderos/deploy/backup-db.sh >> $HOME/backups/backup.log 2>&1",
    "*/20 * * * * PATH=/usr/local/bin:/usr/bin:/bin PR_BRAIN_ROOT=/opt/review PR_BRAIN_ENV_FILE=/opt/founderos/.env $HOME/bin/pr-brain >/dev/null 2>>$HOME/.claude/pr-brain.log",
  ];
  const KICK_LINE =
    "* * * * * PATH=/usr/local/bin:/usr/bin:/bin AGENT_DISPATCH_ENV_FILE=/opt/founderos/.env $HOME/bin/agent-dispatch --kicked >/dev/null 2>>$HOME/.claude/agent-dispatch.log";

  let state: string;
  let crontab: string;

  /** A crontab command backed by a file, with `crontab -l` and `crontab -` as the real one has them. */
  function fakeCrontab(initial: string | null, dropKicked = false): void {
    state = join(root, "crontab.state");
    crontab = join(root, "crontab-stub");
    if (initial !== null) writeFileSync(state, initial);
    writeFileSync(
      crontab,
      `#!/usr/bin/env bash
if [ "$1" = "-l" ]; then [ -f "${state}" ] && { cat "${state}"; exit 0; }; echo "no crontab for tester" >&2; exit 1; fi
if [ "$1" = "-" ]; then ${dropKicked ? `grep -v -e '--kicked' >"${state}"` : `cat >"${state}"`}; exit 0; fi
exit 2
`,
      { mode: 0o755 },
    );
  }
  const stateLines = (): string[] => readFileSync(state, "utf8").split("\n").filter(Boolean);

  it("adds one kick line, copied from the agent-dispatch line (same PATH and env file), and keeps every other line", () => {
    fakeCrontab([...OTHER_LINES, "", AGENT_LINE, ""].join("\n"));

    const r = sync({ SYNC_DAEMONS_CRONTAB: crontab });

    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("sync-daemons: kick cron installed:");
    const lines = stateLines();
    expect(lines).toContain(KICK_LINE);
    for (const line of [...OTHER_LINES, AGENT_LINE]) expect(lines, line).toContain(line);
    expect(lines).toHaveLength(OTHER_LINES.length + 2);
  });

  it("is idempotent: a second deploy changes nothing and says so", () => {
    fakeCrontab([...OTHER_LINES, AGENT_LINE].join("\n") + "\n");
    sync({ SYNC_DAEMONS_CRONTAB: crontab });
    const once = readFileSync(state, "utf8");

    const second = sync({ SYNC_DAEMONS_CRONTAB: crontab });

    expect(second.status, second.err).toBe(0);
    expect(readFileSync(state, "utf8")).toBe(once);
    expect(second.out).toContain("kick cron already installed");
    expect(stateLines().filter((l) => l.includes("--kicked"))).toHaveLength(1);
  });

  it("does not take a commented-out agent-dispatch line as the one to copy, or as already installed", () => {
    fakeCrontab(`# ${AGENT_LINE}\n# ${KICK_LINE}\n${OTHER_LINES[0]}\n`);

    const r = sync({ SYNC_DAEMONS_CRONTAB: crontab });

    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("WARNING: no agent-dispatch line in the crontab");
    expect(stateLines().some((l) => !l.startsWith("#") && l.includes("--kicked"))).toBe(false);
  });

  it("warns and installs nothing when there is no agent-dispatch line to copy the environment from", () => {
    fakeCrontab(OTHER_LINES.join("\n") + "\n");

    const r = sync({ SYNC_DAEMONS_CRONTAB: crontab });

    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("WARNING: no agent-dispatch line in the crontab");
    expect(stateLines()).toEqual(OTHER_LINES);
  });

  it("copes with a user who has no crontab at all", () => {
    fakeCrontab(null);

    const r = sync({ SYNC_DAEMONS_CRONTAB: crontab });

    expect(r.status, r.err).toBe(0);
    expect(existsSync(state)).toBe(false);
    expect(r.out).toContain("WARNING: no agent-dispatch line");
  });

  it("fails loudly, and puts the old crontab back, when the new line does not stick", () => {
    fakeCrontab([...OTHER_LINES, AGENT_LINE].join("\n") + "\n", true);

    const r = sync({ SYNC_DAEMONS_CRONTAB: crontab });

    expect(r.status).toBe(1);
    expect(r.err).toMatch(/the crontab does not hold the line/);
    expect(stateLines()).toEqual([...OTHER_LINES, AGENT_LINE]);
  });

  it("never edits the real crontab when HOME is a scratch directory (every other test here runs that way)", () => {
    // A `crontab` on PATH that records any call. Under a scratch HOME the script must not reach it.
    const calls = join(root, "real-crontab-calls");
    const shimDir = join(root, "crontab-shim");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "crontab"), `#!/bin/bash\necho "$*" >>"${calls}"\nexit 0\n`, { mode: 0o755 });

    const r = sync({}, `${shimDir}:/usr/bin:/bin`);

    expect(r.status, r.err).toBe(0);
    expect(existsSync(calls)).toBe(false);
    expect(r.out).toContain("kick cron left alone");
  });

  it("the transformation is exactly: five schedule fields -> every minute, and `--kicked` after agent-dispatch", () => {
    fakeCrontab(AGENT_LINE + "\n");
    sync({ SYNC_DAEMONS_CRONTAB: crontab });
    expect(stateLines()[1]).toBe(KICK_LINE);
  });
});
