/**
 * deploy/opendots/setup-dots.sh against a fake owner API (curl), docker and crontab. No network.
 * 2026-10-13 (founder: "simplify the setup"): the GitHub-label pipeline (team-shift, chief-run, shift-cron,
 * shift-notify) is retired. Every Dot leads claude/agy in its own computer through run-bg; recurring work uses the app's
 * own scheduled tasks. A rerun removes the pipeline's cron lines and cancels its shift tasks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SETUP = join(ROOT, "deploy", "opendots", "setup-dots.sh");
const FAKES = join(ROOT, "tests", "unit", "scripts", "fakes");
const TOKEN = "owner-token-not-for-output";

interface Task { id: string; prompt: string; status: string; intervalSeconds: number | null }

let dir: string;
let fake: string;

function bin(name: string): void {
  const path = join(fake, "bin", name);
  writeFileSync(path, readFileSync(join(FAKES, `opendots-${name}.sh`), "utf8"));
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "setup-dots-"));
  fake = join(dir, "fake");
  spawnSync("mkdir", ["-p", join(fake, "bin"), join(dir, "app")]);
  writeFileSync(join(dir, "app", ".env"), `X=1\nOWNER_TOKEN=${TOKEN}\n`);
  for (const name of ["curl", "docker", "crontab"]) bin(name);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(tasks: Task[] = [], extraDots: string[][] = []) {
  const dots = [["Chief of Staff", "chief"], ["Builder", "b"], ["Architect", "a"], ["Reviewer", "r"], ...extraDots];
  writeFileSync(join(fake, "workspace.json"), JSON.stringify({
    spaces: [{ name: "Everyday", id: "s1" }],
    dots: dots.map(([name, id]) => ({ name, id })),
    conversations: [],
  }));
  writeFileSync(join(fake, "state.json"), JSON.stringify({ tasks }));
  const r = spawnSync("bash", [SETUP], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(fake, "bin")}:${process.env["PATH"] ?? ""}`, FAKE: fake,
      FAKE_OWNER_TOKEN: TOKEN, OPENDOTS_APP: join(dir, "app") },
  });
  const calls = existsSync(join(fake, "curl.log")) ? readFileSync(join(fake, "curl.log"), "utf8").trim().split("\n") : [];
  const docker = existsSync(join(fake, "docker.log")) ? readFileSync(join(fake, "docker.log"), "utf8").trim().split("\n") : [];
  return { status: r.status, out: r.stdout + r.stderr, calls, docker };
}

const instructions = (calls: string[], id: string): string => {
  const put = calls.find((c) => c.startsWith(`PUT /dots/${id} `));
  return (JSON.parse(put?.slice(`PUT /dots/${id} `.length) ?? "{}") as { instructions?: string }).instructions ?? "";
};
const shiftTask = (role: string, status = "paused"): Task =>
  ({ id: `t-${role}`, prompt: `${role} shift: follow your SHIFT rules for one item, or reply "No work".`, status, intervalSeconds: null });

describe("setup-dots.sh", () => {
  // Audit 2026-10-13: Dots did paid tools' work by hand (164 shell calls for one Reviewer request), reported checks
  // they never ran, and deflected to the Chief. Every prompt leads claude/agy through run-bg and demands evidence.
  it("gives every Dot a delegate-first, research-first prompt within 2000 characters and no retired command", () => {
    const r = setup([], [["DevOps", "d"]]);
    expect(r.status, r.out).toBe(0);
    for (const id of ["chief", "b", "a", "r", "d"]) {
      const prompt = instructions(r.calls, id);
      expect([...prompt].length, id).toBeLessThanOrEqual(2000);
      for (const s of ["claude -p", "run-bg start", "run-bg wait", "timeoutMs 60000", "agy", "NOT VERIFIED", "another Dot", "already exists"])
        expect(prompt, `${id}: ${s}`).toContain(s);
      expect(prompt, id).not.toMatch(/team-shift|chief-run|SHIFT/);
    }
    expect(instructions(r.calls, "r")).toContain("pr-adversary");
    expect(instructions(r.calls, "d")).toContain("dot-task create");
    // 2026-10-13 live: DevOps waited in its own turn for a run that could start only after that turn (one task at a
    // time) and failed at the step limit (opendots-dot-task.test.ts).
    expect(instructions(r.calls, "d")).toContain("never wait for it; dot-task show <id>");
    expect(r.out).not.toContain(TOKEN);
  });

  it("gives every computer, DevOps included, full permissions, the Builder's logins, the helpers and the rules", () => {
    const r = setup([], [["DevOps", "d"]]);
    expect(r.status, r.out).toBe(0);
    for (const box of ["chief", "b", "a", "r", "d"]) {
      expect(r.calls).toContain(`PATCH /dots/${box}/computer/permissions {"enabled":true,"browser":true,"files":true,"shell":true}`);
      // Renamed into place: root in an unprivileged computer cannot overwrite the ubuntu-owned run-bg of older images.
      expect(r.docker).toContain(`exec -i opendots-computer-${box} sh -c f=/usr/local/bin/$1; cat > "$f.new" && chmod 755 "$f.new" && mv -f "$f.new" "$f" sh run-bg`);
      expect(r.docker).toContain(`exec -i -w /workspace opendots-computer-${box} tar -xf - --no-same-owner --no-overwrite-dir`);
    }
    // Both ends of one copy pipe log in either order, but copies run one after another: the k-th tar -xf reads the
    // k-th tar -cf. The Builder is the source; every other computer gets its logins without overwriting its own.
    const packs = r.docker.filter((l) => l.includes(" tar -cf ") && l.includes(".claude-token"));
    const unpacks = r.docker.filter((l) => l.includes("--skip-old-files"));
    expect(unpacks.map((l) => l.split(" ")[4])).toEqual(["opendots-computer-a", "opendots-computer-r", "opendots-computer-chief", "opendots-computer-d"]);
    for (const p of packs) {
      expect(p).toContain("opendots-computer-b ");
      expect(p).toContain(".gemini/antigravity-cli/antigravity-oauth-token");
    }
    expect(r.docker.some((l) => l.includes("team-repos"))).toBe(false);
  });

  // run-bg wait must return inside one 60 s shell call.
  it("keeps run-bg wait under 55 s", () => {
    const waitSeconds = /for \(\(i = 0; i < (\d+); i\+\+\)\)/.exec(readFileSync(join(ROOT, "deploy", "opendots", "run-bg"), "utf8"));
    expect(Number(waitSeconds?.[1])).toBeLessThanOrEqual(55);
  });

  it("removes the retired shift cron lines and keeps every other line", () => {
    writeFileSync(join(fake, "crontab"), "*/2 * * * * other-job\n*/1 * * * * x # opendots-shift\n* * * * * y # opendots-notify\n");
    const r = setup();
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(fake, "crontab"), "utf8")).toBe("*/2 * * * * other-job\n");
  });

  it("leaves a crontab without shift lines untouched", () => {
    writeFileSync(join(fake, "crontab"), "*/2 * * * * other-job\n");
    const r = setup();
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(fake, "crontab"), "utf8")).toBe("*/2 * * * * other-job\n");
  });

  it("cancels the retired shift tasks, never creates one, and leaves other tasks alone", () => {
    const other: Task = { id: "t-other", prompt: "Weekly uptime report", status: "paused", intervalSeconds: 604800 };
    const r = setup([shiftTask("Architect"), shiftTask("Builder", "completed"), shiftTask("Reviewer", "cancelled"), other]);
    expect(r.status, r.out).toBe(0);
    const actions = r.calls.filter((c) => c.startsWith("POST /tasks/"));
    expect(actions).toEqual([
      'POST /tasks/t-Architect/actions {"action":"cancel"}',
      'POST /tasks/t-Builder/actions {"action":"cancel"}',
    ]);
    expect(r.calls.some((c) => c.startsWith("POST /tasks "))).toBe(false);
  });

  // 2026-10-13: a Learning container ID that does not exist in Intelligence fails every new conversation with
  // "Thread lock denied" (404 LEARNING_CONTAINER_NOT_FOUND); saving the ID never creates the container.
  it("turns Learning off on every Dot it writes", () => {
    const r = setup([], [["DevOps", "d"]]);
    expect(r.status, r.out).toBe(0);
    const writes = r.calls.filter((c) => /^(PUT|POST) \/dots[/ ]/.test(c) && c.includes('"instructions"'));
    expect(writes.length).toBeGreaterThanOrEqual(5);
    for (const w of writes) {
      const body = JSON.parse(w.slice(w.indexOf("{"))) as { learningContainerId?: unknown; skillDeliveryEnabled?: unknown };
      expect(body.learningContainerId, w.slice(0, 20)).toBeNull();
      expect(body.skillDeliveryEnabled, w.slice(0, 20)).toBe(false);
    }
  });

  it("never creates a DevOps Dot that does not exist", () => {
    const r = setup();
    expect(r.status, r.out).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("POST /dots "))).toHaveLength(0);
    expect(r.calls.some((c) => c.includes('"name":"DevOps"'))).toBe(false);
  });
});
