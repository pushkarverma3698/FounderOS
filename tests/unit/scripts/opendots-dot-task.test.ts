/**
 * deploy/opendots/dot-task against a fake owner API (curl). No network.
 * 2026-10-13 live run: DevOps created a 6-hour routine, ran `dot-task run` and waited for the answer inside its own
 * turn. The app runs one task at a time (runner.ts: `if (this.active.size) return`), so the routine could only start
 * once that turn ended: the turn burned its 30 model calls and failed. `show` reads a task's last answer later.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DOT_TASK = join(ROOT, "deploy", "opendots", "dot-task");
const TOKEN = "owner-token-not-for-output";

let fake: string;
beforeEach(() => {
  fake = mkdtempSync(join(tmpdir(), "dot-task-"));
  spawnSync("mkdir", ["-p", join(fake, "bin")]);
  writeFileSync(join(fake, "bin", "curl"), readFileSync(join(ROOT, "tests", "unit", "scripts", "fakes", "opendots-curl.sh"), "utf8"));
  chmodSync(join(fake, "bin", "curl"), 0o755);
});
afterEach(() => rmSync(fake, { recursive: true, force: true }));

function dotTask(...args: string[]) {
  const r = spawnSync("bash", [DOT_TASK, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(fake, "bin")}:${process.env["PATH"] ?? ""}`, FAKE: fake,
      FAKE_OWNER_TOKEN: TOKEN, OPENDOTS_TOKEN: TOKEN, OPENDOTS_API: "http://127.0.0.1:4310/api" },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe("dot-task", () => {
  it("show prints the task's status, interval, last run and its answer", () => {
    writeFileSync(join(fake, "task-t1.json"), JSON.stringify({
      task: { id: "t1", status: "completed", intervalSeconds: 21600, prompt: "Disk and memory, one line." },
      // Newest first, as GET /api/tasks/:id lists them (live, 2026-10-13).
      runs: [
        { status: "completed", error: null, result: { text: "disk 59G/75G (82%), mem 3.1G/7.7G (40%)" } },
        { status: "failed", error: "old failure", result: null },
      ],
      events: [],
    }));
    const r = dotTask("show", "t1");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("completed");
    expect(r.out).toContain("21600");
    expect(r.out).toContain("disk 59G/75G (82%), mem 3.1G/7.7G (40%)");
    expect(r.out).not.toContain("old failure");
    expect(r.out).not.toContain(TOKEN);
  });

  it("show says plainly when a task has not run yet", () => {
    writeFileSync(join(fake, "task-t2.json"), JSON.stringify({
      task: { id: "t2", status: "queued", intervalSeconds: null, prompt: "x" }, runs: [], events: [],
    }));
    const r = dotTask("show", "t2");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("queued");
    expect(r.out).toContain("no run yet");
  });

  it("has no loop: recurring work is a scheduled task, not a second scheduler", () => {
    const r = dotTask("loop", "x", "60", "true");
    expect(r.status).toBe(2);
    expect(r.out).not.toMatch(/loop/);
  });
});
