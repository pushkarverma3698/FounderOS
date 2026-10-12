/**
 * deploy/opendots/shift-notify: the host cron that tells the founder on Telegram when a role finishes or blocks.
 * Runs against a fake docker (each computer's last-<role>.txt) and a fake curl (the Telegram call). No network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const NOTIFY = join(ROOT, "deploy", "opendots", "shift-notify");
const TOKEN = "123:bot-token-not-for-output";
const DONE = `2026-10-12 13:06 UTC
Done: owner/sandbox pr #34.
WHAT I DID: Ran the tests.
RESULT: PASS on https://github.com/owner/sandbox/pull/34, label agent:approved.`;
const BLOCKED = `2026-10-12 14:00 UTC
Blocked: owner/sandbox issue #7. Builder: which currency should the invoice use?
It is not in the plan.`;

let dir: string;
let fake: string;

function bin(name: string, body: string): void {
  const path = join(fake, "bin", name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
const last = (role: string, text: string): void => writeFileSync(join(fake, `last-${role}.txt`), `${text}\n`);

function notify(envFile = `X=1\nTELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=4242\n`) {
  writeFileSync(join(dir, "founderos.env"), envFile);
  writeFileSync(join(dir, "shift-tasks"), "architect dot-a task-a\nbuilder dot-b task-b\nreviewer dot-r task-r\n");
  rmSync(join(fake, "tg.log"), { force: true });
  const r = spawnSync("bash", [NOTIFY], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(fake, "bin")}:${process.env["PATH"] ?? ""}`, FAKE: fake,
      OPENDOTS_SHIFT_TASKS: join(dir, "shift-tasks"), OPENDOTS_NOTIFY_ENV: join(dir, "founderos.env") },
  });
  const sent = existsSync(join(fake, "tg.log")) ? readFileSync(join(fake, "tg.log"), "utf8").split("\n--\n").filter(Boolean) : [];
  return { status: r.status, out: r.stdout + r.stderr, sent };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notify-"));
  fake = join(dir, "fake");
  mkdirSync(join(fake, "bin"), { recursive: true });
  // `docker exec opendots-computer-dot-<x> cat /workspace/runs/last-<role>.txt`
  bin("docker", `#!/bin/sh\nf="$FAKE/$(basename "$4")"\n[ -f "$f" ] || exit 1\ncat "$f"\n`);
  // The URL (with the token) arrives as a curl config on stdin; the message fields are arguments.
  bin("curl", `#!/bin/sh\ncat > "$FAKE/tg-config"\n[ -e "$FAKE/tg-fail" ] && exit 22\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "$FAKE/tg.log"\nprintf -- '--\\n' >> "$FAKE/tg.log"\n`);
  bin("timeout", '#!/bin/sh\nshift\nexec "$@"\n'); // macOS has no timeout(1); the VPS does
  bin("flock", `#!/bin/sh\n[ -e "$FAKE/locked" ] && exit 1\nexit 0\n`); // nor flock(1)
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("shift-notify: one Telegram message per new outcome", () => {
  it("the first run sends nothing: what is already there is old news", () => {
    last("reviewer", DONE);
    const r = notify();
    expect(r.status, r.out).toBe(0);
    expect(r.sent).toEqual([]);
  });

  it("a new outcome is sent once, with the role, the item and the RESULT line", () => {
    notify(); // no outcome anywhere yet
    last("reviewer", DONE);
    const r = notify();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain("chat_id=4242");
    expect(r.sent[0]).toContain("text=✅ Reviewer finished: sandbox pr #34\nPASS on https://github.com/owner/sandbox/pull/34, label agent:approved.");
    expect(r.sent[0]).not.toContain("WHAT I DID");
    expect(readFileSync(join(fake, "tg-config"), "utf8")).toBe(`url = "https://api.telegram.org/bot${TOKEN}/sendMessage"\n`);
    expect(r.out).toContain("reviewer: sent");
    expect(notify().sent).toEqual([]);
  });

  // Stacked PRs: team-shift adds the merge order under a PASS. The founder merges from his phone, so it must arrive.
  it("a finished review of a stacked PR also carries the merge order", () => {
    notify();
    last("reviewer", `${DONE}\nMerge order, first to last: #33 (approved), #34 (approved). All approved: say merge for each, in this order.`);
    const r = notify();
    expect(r.sent[0]).toContain("label agent:approved.\nMerge order, first to last: #33 (approved), #34 (approved). All approved: say merge for each, in this order.");
  });

  it("a blocked item carries the question and a link to the item", () => {
    notify();
    last("builder", BLOCKED);
    const r = notify();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain("text=⛔ Builder is blocked and needs you: sandbox issue #7\nBuilder: which currency should the invoice use?\nIt is not in the plan.\nhttps://github.com/owner/sandbox/issues/7");
  });

  it("a run that blocked the item itself is announced as blocked, not finished", () => {
    notify();
    last("builder", "2026-10-12 13:24 UTC\nDone: owner/sandbox issue #38.\nWHAT I DID: Wrote no code.\nRESULT: Blocked on #37 (Part B). https://github.com/owner/sandbox/issues/38");
    const r = notify();
    expect(r.sent[0]).toContain("text=⛔ Builder is blocked and needs you: sandbox issue #38\nBlocked on #37 (Part B).");
  });

  it("a failed send is retried on the next run", () => {
    notify();
    last("architect", DONE.replace("pr #34", "issue #3"));
    writeFileSync(join(fake, "tg-fail"), "");
    const failed = notify();
    expect(failed.sent).toEqual([]);
    expect(failed.out).toContain("architect: Telegram send failed, trying again next run");
    rmSync(join(fake, "tg-fail"));
    expect(notify().sent).toHaveLength(1);
  });

  it("the token never reaches the output or curl's arguments", () => {
    notify();
    last("reviewer", DONE);
    const r = notify();
    expect(r.out).not.toContain(TOKEN);
    expect(r.sent.join("\n")).not.toContain(TOKEN);
  });

  it("without a token it says so and sends nothing", () => {
    last("reviewer", DONE);
    const r = notify("X=1\n");
    expect(r.status).toBe(1);
    expect(r.out).toContain("no TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    expect(r.sent).toEqual([]);
  });

  it("does nothing while another run holds the lock", () => {
    notify();
    last("reviewer", DONE);
    writeFileSync(join(fake, "locked"), "");
    expect(notify().sent).toEqual([]);
  });
});
