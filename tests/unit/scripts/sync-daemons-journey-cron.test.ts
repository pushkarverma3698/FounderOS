/**
 * The morning journey cron line is installed by deploy — deploy/sync-daemons.sh, ensure_journey_cron.
 * =====================================================================================================
 * AG-051: one 08:00 IST run (scripts/journey-daily.ts) replaces the hand-installed journey B and C lines. Journey A
 * runs daily at 01:30 UTC from its own line (#1058), replacing the old 3-day one. The edit is read back and the old crontab restored when any kept line did not survive,
 * the same safety the kick-cron removal has. Own file (not sync-daemons.test.ts) so it does not collide with other
 * work on that file; same harness: a fake HOME and a crontab command backed by a file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SYNC = fileURLToPath(new URL("../../../deploy/sync-daemons.sh", import.meta.url));

const RUN = "cd /opt/founderos && PATH=/usr/local/bin:/usr/bin:/bin node --import tsx/esm --env-file=.env";
/** The exact line deploy installs. */
const DAILY = `30 2 * * * ${RUN} scripts/journey-daily.ts >> $HOME/.claude/journey-daily.log 2>&1`;
/** Journey A, daily at 01:30 UTC so its result is under an hour old when the morning run scores it (#1058). */
const A_DAILY = `30 1 * * * ${RUN} scripts/journey-coding.ts >> $HOME/.claude/journey-a.log 2>&1`;
// What the box really has (crontab -l on founderos-vps, 2026-10-08), the journey lines.
const C_LINE = `30 2 * * * ${RUN} scripts/journey-jobs-group.ts >> $HOME/.claude/journey-c.log 2>&1`;
const B_LINE = `45 2 * * * ${RUN} scripts/journey-where.ts >> $HOME/.claude/journey-b.log 2>&1`;
const A_LINE = `0 3 */3 * * ${RUN} scripts/journey-coding.ts >> $HOME/.claude/journey-a.log 2>&1`;
const OTHER = [
  "*/2 * * * * $HOME/bin/founderos-watchdog.sh >> /tmp/founderos-watchdog.log 2>&1",
  "17 3 * * * BACKUP_DIR=$HOME/backups /opt/founderos/deploy/backup-db.sh >> $HOME/backups/backup.log 2>&1",
];

let root: string;
let home: string;
let state: string;
let crontab: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-journey-cron-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  state = join(root, "crontab.state");
  crontab = join(root, "crontab-stub");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A crontab command backed by a file, with `crontab -l` and `crontab -` as the real one has them. */
function fakeCrontab(initial: string | null, writes: "store" | "ignore" | "drop-first" = "store"): void {
  if (initial !== null) writeFileSync(state, initial);
  const onWrite = { store: `cat >"${state}"`, ignore: "cat >/dev/null", "drop-first": `tail -n +2 >"${state}"` }[writes];
  writeFileSync(
    crontab,
    `#!/usr/bin/env bash
if [ "$1" = "-l" ]; then [ -f "${state}" ] && { cat "${state}"; exit 0; }; echo "no crontab for tester" >&2; exit 1; fi
if [ "$1" = "-" ]; then ${onWrite}; exit 0; fi
exit 2
`,
    { mode: 0o755 },
  );
}

const lines = (): string[] => readFileSync(state, "utf8").split("\n").filter(Boolean);

function sync(env: Record<string, string> = {}, path = "/usr/bin:/bin") {
  const r = spawnSync("bash", [SYNC], { env: { PATH: path, HOME: home, ...env }, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("sync-daemons.sh — the morning journey cron", () => {
  it("installs A daily at 01:30 and the 02:30 UTC morning run, removes the 3-day A, B and C lines, keeps every other line", () => {
    fakeCrontab([...OTHER, C_LINE, B_LINE, A_LINE, ""].join("\n"));

    const r = sync({ SYNC_DAEMONS_JOURNEY_CRONTAB: crontab });

    expect(r.status, r.err).toBe(0);
    expect(lines()).toEqual([...OTHER, A_DAILY, DAILY]);
    expect(r.out).toContain(
      "sync-daemons: journey cron installed: scripts/journey-coding.ts at 01:30 UTC, scripts/journey-daily.ts at 02:30 UTC (08:00 IST), 3 old journey lines removed",
    );
  });

  it("moves the box's real crontab (10-09: the 3-day A line and the daily line) to A daily", () => {
    fakeCrontab([...OTHER, A_LINE, DAILY].join("\n") + "\n");

    const r = sync({ SYNC_DAEMONS_JOURNEY_CRONTAB: crontab });

    expect(r.status, r.err).toBe(0);
    expect(lines()).toEqual([...OTHER, A_DAILY, DAILY]);
    expect(r.out).toContain("1 old journey lines removed");
  });

  it("is idempotent: a second deploy finds the line and writes nothing", () => {
    fakeCrontab([...OTHER, C_LINE, B_LINE, A_LINE].join("\n") + "\n");
    sync({ SYNC_DAEMONS_JOURNEY_CRONTAB: crontab });
    const once = readFileSync(state, "utf8");

    const second = sync({ SYNC_DAEMONS_JOURNEY_CRONTAB: crontab });

    expect(second.status, second.err).toBe(0);
    expect(readFileSync(state, "utf8")).toBe(once);
    expect(lines().filter((l) => l === DAILY)).toHaveLength(1);
    expect(lines().filter((l) => l === A_DAILY)).toHaveLength(1);
    expect(second.out).toContain("journey cron already installed");
  });

  it("replaces a hand-edited daily line rather than adding a second one", () => {
    fakeCrontab([...OTHER, `15 1 * * * ${RUN} scripts/journey-daily.ts`].join("\n") + "\n");

    const r = sync({ SYNC_DAEMONS_JOURNEY_CRONTAB: crontab });

    expect(r.status, r.err).toBe(0);
    expect(lines()).toEqual([...OTHER, A_DAILY, DAILY]);
  });

  it("leaves commented-out journey lines alone", () => {
    fakeCrontab(`# ${B_LINE}\n${OTHER[0]}\n`);

    const r = sync({ SYNC_DAEMONS_JOURNEY_CRONTAB: crontab });

    expect(r.status, r.err).toBe(0);
    expect(lines()).toEqual([`# ${B_LINE}`, OTHER[0], A_DAILY, DAILY]);
  });

  it("installs the line for a user who has no crontab yet", () => {
    fakeCrontab(null);

    const r = sync({ SYNC_DAEMONS_JOURNEY_CRONTAB: crontab });

    expect(r.status, r.err).toBe(0);
    expect(lines()).toEqual([A_DAILY, DAILY]);
  });

  it("fails loudly, and puts the old crontab back, when the write does not stick", () => {
    fakeCrontab([...OTHER, B_LINE].join("\n") + "\n", "ignore");

    const r = sync({ SYNC_DAEMONS_JOURNEY_CRONTAB: crontab });

    expect(r.status).toBe(1);
    expect(r.err).toMatch(/journey cron/);
    expect(lines()).toEqual([...OTHER, B_LINE]);
  });

  it("restores the old crontab when a kept line is lost on the write", () => {
    fakeCrontab([...OTHER, B_LINE].join("\n") + "\n", "drop-first");

    const r = sync({ SYNC_DAEMONS_JOURNEY_CRONTAB: crontab });

    expect(r.status).toBe(1);
    expect(r.err).toContain(`lost the line '${OTHER[0]}'`);
    // The restore goes through the same broken command, so assert the restore was attempted with the full old crontab:
    // the stub drops line 1 of whatever it is given, so what is left is the old crontab minus its first line.
    expect(lines()).toEqual([OTHER[1], B_LINE]);
  });

  it("never edits the real crontab when HOME is a scratch directory", () => {
    const calls = join(root, "real-crontab-calls");
    const shimDir = join(root, "crontab-shim");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "crontab"), `#!/bin/bash\necho "$*" >>"${calls}"\nexit 0\n`, { mode: 0o755 });

    const r = sync({}, `${shimDir}:/usr/bin:/bin`);

    expect(r.status, r.err).toBe(0);
    expect(existsSync(calls)).toBe(false);
    expect(r.out).toContain("journey cron left alone");
  });
});
