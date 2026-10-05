/**
 * CI mechanism for the screen log (rule #27): a daemon that sends to Telegram without logging the
 * message puts text on the founder's screen that the planner cannot see, and "which repo is that on?"
 * goes back to being a guess (2026-10-04). Every Telegram send or edit under deploy/ must sit next to
 * a tg_screen_log call in the same file.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY = fileURLToPath(new URL("../../../deploy", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/** Files allowed to send without logging, each with its reason. */
const EXEMPT: Record<string, string> = {
  // Its one message means the bot is down and restarting did not help; nobody can ask the bot about it
  // until it is back, and the watchdog is shipped on its own, without the deploy/lib helpers.
  "deploy/watchdog.sh": "bot-down alert",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const SEND_RE = /api\.telegram\.org\/bot[^\s"']*\/(sendMessage|sendPhoto|sendDocument|editMessageText)/g;

describe("every Telegram send under deploy/ is logged to the screen log", () => {
  const senders = files(DEPLOY)
    .map((p) => ({ rel: relative(REPO, p), text: readFileSync(p, "utf8") }))
    .filter((f) => new RegExp(SEND_RE.source).test(f.text));

  it("finds the daemons it is meant to guard", () => {
    expect(senders.map((f) => f.rel)).toEqual(
      expect.arrayContaining(["deploy/agent-dispatch", "deploy/vps-daemons/pr-brain", "deploy/lib/agy-run.sh", "deploy/lib/tg-quiet.sh"]),
    );
  });

  for (const rel of ["deploy/agent-dispatch", "deploy/vps-daemons/pr-brain", "deploy/lib/agy-run.sh", "deploy/lib/tg-quiet.sh"]) {
    it(`${rel}: one tg_screen_log call per send`, () => {
      const text = readFileSync(join(REPO, rel), "utf8");
      const sends = text.match(SEND_RE)?.length ?? 0;
      const logs = text.match(/^[^#\n]*\btg_screen_log "/gm)?.length ?? 0; // call sites, not comments or the definition
      expect(logs).toBeGreaterThanOrEqual(sends);
    });
  }

  it("has no unlogged sender outside the exempt list", () => {
    const unlogged = senders.filter((f) => !/\btg_screen_log\b/.test(f.text) && !(f.rel in EXEMPT)).map((f) => f.rel);
    expect(unlogged).toEqual([]);
  });
});
