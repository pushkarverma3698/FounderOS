/**
 * deploy/opendots/team-services: Postgres and Redis as local processes inside an OpenDots computer (no docker there).
 * Runs against fake initdb, pg_ctl, psql, runuser, redis-server and redis-cli that keep their state in files.
 * No real server starts, no port opens.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(ROOT, "deploy", "opendots", "team-services");

let dir: string; // fake binaries and their state
let data: string; // TEAM_SERVICES_ROOT
let pgBin: string; // TEAM_PG_BIN

function bin(where: string, name: string, body: string): void {
  const path = join(where, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "team-services-"));
  data = join(dir, "data-root");
  pgBin = join(dir, "pgbin");
  mkdirSync(pgBin);
  mkdirSync(join(dir, "bin"));
  // Every fake logs its arguments. "up" markers stand in for a listening server; `never-up` makes a server start but never answer.
  const log = `echo "$(basename "$0") $*" >> "$FAKE/calls.log"`;
  bin(pgBin, "initdb", `${log}\nwhile [ $# -gt 0 ]; do [ "$1" = -D ] && d=$2; shift; done; mkdir -p "$d"; touch "$d/PG_VERSION"`);
  bin(pgBin, "pg_ctl", `${log}
for a in "$@"; do case $a in start|stop) c=$a;; esac; done
while [ $# -gt 0 ]; do [ "$1" = -D ] && d=$2; [ "$1" = -o ] && o=$2; shift; done
case $c in
  start) p=\${o#*-p }; p=\${p%% *}; echo "$o" > "$FAKE/pg-opts"; echo 1 > "$d/postmaster.pid"; [ -e "$FAKE/never-up" ] || echo "$p" > "$FAKE/pg-up";;
  stop) rm -f "$FAKE/pg-up" "$d/postmaster.pid";;
esac`);
  bin(pgBin, "psql", `${log}\n[ -e "$FAKE/pg-up" ] || exit 2\nexit 0`);
  bin(join(dir, "bin"), "runuser", `${log}\nshift 2; [ "$1" = -- ] && shift; exec "$@"`);
  bin(join(dir, "bin"), "redis-server", `${log}
while [ $# -gt 0 ]; do [ "$1" = --port ] && p=$2; [ "$1" = --dir ] && d=$2; shift; done
echo $$ > "$d/redis.pid"; [ -e "$FAKE/never-up" ] || echo "$p" > "$FAKE/redis-up"`);
  bin(join(dir, "bin"), "redis-cli", `${log}
case " $* " in
  *" ping "*) [ -e "$FAKE/redis-up" ] && echo PONG || exit 1;;
  *" shutdown "*) rm -f "$FAKE/redis-up";;
esac`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function svc(...args: string[]): { out: string; err: string; status: number | null } {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? ""}`,
      FAKE: dir,
      TEAM_SERVICES_ROOT: data,
      TEAM_PG_BIN: pgBin,
      TEAM_PG_USER: "", // runuser is checked in its own test
      TEAM_SERVICES_WAIT: "1",
    },
  });
  return { out: r.stdout.trim(), err: r.stderr, status: r.status };
}
const calls = (): string => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "");

describe("team-services start", () => {
  it("starts Postgres and Redis, and prints where they listen", () => {
    const r = svc("start", "postgres", "redis");
    expect(r.status).toBe(0);
    expect(r.out).toBe("postgres started on 127.0.0.1:5432\nredis started on 127.0.0.1:6379");
    expect(svc("status").out).toBe("postgres running 127.0.0.1:5432\nredis running 127.0.0.1:6379");
  });

  it("creates the one test role and database team, with low-memory settings", () => {
    svc("start", "postgres");
    expect(calls()).toMatch(/initdb .*-U team /);
    expect(calls()).toContain("create database team");
    const opts = readFileSync(join(dir, "pg-opts"), "utf8");
    expect(opts).toContain("shared_buffers=32MB");
    expect(opts).toContain("max_connections=20");
  });

  it("is a no-op the second time: no second initdb, no second server", () => {
    svc("start", "postgres", "redis");
    const again = svc("start", "postgres", "redis");
    expect(again.status).toBe(0);
    expect(again.out).toBe("postgres already running on 127.0.0.1:5432\nredis already running on 127.0.0.1:6379");
    expect(calls().split("\n").filter((l) => l.startsWith("initdb")).length).toBe(1);
    expect(calls().split("\n").filter((l) => l.startsWith("redis-server")).length).toBe(1);
  });

  it("listens on 127.0.0.1 only", () => {
    svc("start", "postgres", "redis");
    expect(readFileSync(join(dir, "pg-opts"), "utf8")).toContain("listen_addresses=127.0.0.1");
    expect(calls()).toMatch(/redis-server .*--bind 127\.0\.0\.1 /);
    expect(calls()).not.toContain("0.0.0.0");
  });

  it("keeps all data under the services root, runs Redis with a 64 MB cap and no persistence", () => {
    svc("start", "postgres", "redis");
    expect(calls()).toContain(`-D ${join(data, "postgres", "data")}`);
    expect(calls()).toContain(`--dir ${join(data, "redis")}`);
    expect(calls()).toContain("--maxmemory 64mb");
    expect(calls()).toContain("--appendonly no");
    expect(existsSync(join(data, "postgres", "data", "PG_VERSION"))).toBe(true);
  });

  it("takes name:port for a repo whose tests hardcode a port", () => {
    const r = svc("start", "redis:6380", "postgres:5544");
    expect(r.out).toBe("redis started on 127.0.0.1:6380\npostgres started on 127.0.0.1:5544");
    expect(svc("env").out).toContain("REDIS_PORT=6380");
    expect(svc("env").out).toContain("DATABASE_URL=postgres://team:team@127.0.0.1:5544/team");
  });

  it("refuses to move a running service to another port instead of starting a second one", () => {
    svc("start", "redis");
    const r = svc("start", "redis:6380");
    expect(r.status).toBe(1);
    expect(r.err).toContain("already runs on port 6379");
  });

  it("starts fresh over a stale data dir that a dead server left behind", () => {
    mkdirSync(join(data, "postgres", "data"), { recursive: true });
    writeFileSync(join(data, "postgres", "data", "leftover"), "x");
    writeFileSync(join(data, "postgres", "data", "postmaster.pid"), "999\n");
    expect(svc("start", "postgres").status).toBe(0);
    expect(existsSync(join(data, "postgres", "data", "leftover"))).toBe(false);
    expect(calls()).toMatch(/pg_ctl .*-m immediate .*stop/); // the dead server is cleared first
  });

  it("gives up after the bounded wait with a clear error and a non-zero exit", () => {
    writeFileSync(join(dir, "never-up"), "");
    const t = Date.now();
    const r = svc("start", "redis");
    expect(r.status).toBe(1);
    expect(r.err).toContain("redis did not accept connections on 127.0.0.1:6379 within 1s");
    expect(Date.now() - t).toBeLessThan(8000);
    expect(svc("status").out).toContain("redis stopped");
  });

  it("starts Postgres as the postgres user through runuser when one is configured", () => {
    if (process.getuid?.() === 0) return; // chown to a real user is root's job; the unit run is never root
    const r = spawnSync("bash", [SCRIPT, "start", "postgres"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? ""}`, FAKE: dir, TEAM_SERVICES_ROOT: data, TEAM_PG_BIN: pgBin, TEAM_PG_USER: "nobody", TEAM_SERVICES_WAIT: "1" },
    });
    expect(r.status).toBe(0);
    expect(calls()).toMatch(/runuser -u nobody -- .*initdb /);
    expect(calls()).toMatch(/runuser -u nobody -- .*pg_ctl /);
  });
});

describe("team-services usage", () => {
  it("an unknown service prints usage and exits 2, before starting anything", () => {
    const r = svc("start", "redis", "mongo");
    expect(r.status).toBe(2);
    expect(r.err).toContain("unknown service 'mongo'");
    expect(r.err).toContain("team-services start");
    expect(r.err).not.toContain("set -euo"); // usage is the header comment only
    expect(calls()).toBe("");
  });

  it("no command, an unknown command, start with no name, a bad port: usage and exit 2", () => {
    for (const args of [[], ["restart"], ["start"], ["start", "redis:80"], ["start", "redis:abc"], ["stop", "mongo"], ["run"]]) {
      expect(svc(...args).status, args.join(" ")).toBe(2);
    }
  });
});

describe("team-services env", () => {
  it("prints the connection lines of the running services", () => {
    svc("start", "postgres", "redis");
    const lines = svc("env").out.split("\n");
    expect(lines).toContain("DATABASE_URL=postgres://team:team@127.0.0.1:5432/team");
    expect(lines).toContain("TEST_DATABASE_URL=postgres://team:team@127.0.0.1:5432/team");
    expect(lines).toContain("REDIS_URL=redis://127.0.0.1:6379");
    expect(lines).toContain("REDIS_HOST=127.0.0.1");
    expect(lines).toContain("REDIS_PORT=6379");
  });

  it("prints only what runs, and fails with the next step when nothing does", () => {
    expect(svc("env").status).toBe(1);
    expect(svc("env").err).toContain("team-services start");
    svc("start", "redis");
    expect(svc("env").out).not.toContain("DATABASE_URL");
    expect(svc("env").out).toContain("REDIS_URL=redis://127.0.0.1:6379");
  });
});

describe("team-services run", () => {
  it("runs an allowed command with the connection lines exported", () => {
    svc("start", "postgres", "redis:6380");
    bin(join(dir, "bin"), "node", 'echo "$DATABASE_URL $REDIS_PORT $*"');
    const r = svc("run", "node", "-e", "x");
    expect(r.status).toBe(0);
    expect(r.out).toBe("postgres://team:team@127.0.0.1:5432/team 6380 -e x");
  });

  it("runs nothing but the test runners the role may already run", () => {
    svc("start", "redis");
    const r = svc("run", "curl", "http://example.com");
    expect(r.status).toBe(2);
    expect(r.err).toContain("run takes npm, npx, pnpm, node, python3, pytest or make");
  });

  it("will not run against no services", () => {
    expect(svc("run", "npm", "test").status).toBe(1);
  });
});

describe("team-services stop and status", () => {
  it("stop with no name stops both and deletes their data", () => {
    svc("start", "postgres", "redis");
    const r = svc("stop");
    expect(r.status).toBe(0);
    expect(r.out).toBe("postgres stopped\nredis stopped");
    expect(existsSync(join(data, "postgres"))).toBe(false);
    expect(existsSync(join(data, "redis"))).toBe(false);
    expect(svc("status").out).toBe("postgres stopped\nredis stopped");
  });

  it("stop names one service and leaves the other running; stopping a stopped one is fine", () => {
    svc("start", "postgres", "redis");
    expect(svc("stop", "redis").out).toBe("redis stopped");
    expect(svc("status").out).toBe("postgres running 127.0.0.1:5432\nredis stopped");
    expect(svc("stop", "redis").out).toBe("redis not running");
    expect(svc("stop", "redis").status).toBe(0);
  });

  it("status is one line per service, and works with nothing started", () => {
    const r = svc("status");
    expect(r.status).toBe(0);
    expect(r.out.split("\n")).toEqual(["postgres stopped", "redis stopped"]);
  });

  it("a start after a stop works again (data was deleted)", () => {
    svc("start", "postgres");
    svc("stop", "postgres");
    expect(svc("start", "postgres").out).toBe("postgres started on 127.0.0.1:5432");
  });
});
