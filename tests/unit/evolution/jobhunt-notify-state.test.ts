/**
 * Unit tests — the decision re-notify throttle (founder-lesson addition to plan C3).
 * ==================================================================================
 * `candidate-not-acting` is true TODAY (62 actionable rows, 0 applied) and would
 * repeat, word for word, every morning at 09:30. The 2026-08-21 directive was that
 * paid crons producing no acted-on output get switched off; a free cron that sends
 * the same unactioned line 365 times a year earns the same fate. So a decision
 * finding is told once, again after 7 days if it is still true, and immediately if
 * it is a different finding.
 *
 * The state is a small JSON file under FOUNDEROS_DATA_ROOT (survives deploys, unlike
 * /opt/founderos). A lost or damaged file must degrade to "tell again", never to
 * silence and never to a crash.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const warn = vi.fn();
const info = vi.fn();
vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ warn, info, error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ warn, info, error: vi.fn(), debug: vi.fn() }),
}));

const {
  DECISION_RENOTIFY_DAYS,
  EMPTY_NOTIFY_STATE,
  loadNotifyState,
  notifyStatePath,
  partitionDecisions,
  recordNotified,
  saveNotifyState,
} = await import("../../../src/evolution/jobhunt-notify-state.js");
const { computeFingerprint } = await import("../../../src/evolution/fingerprint.js");

import type { Finding } from "../../../src/evolution/types.js";

const DAY = 86_400_000;
const T0 = new Date("2026-09-29T04:00:00.000Z");
const later = (days: number, from: Date = T0) => new Date(from.getTime() + days * DAY);

const notActing = (profile = "wife-nl-finance"): Finding => ({
  kind: "candidate-not-acting",
  subject: profile,
  evidence: "62 actionable roles, 0 applied",
  severity: "high",
});
const laneSilent = (profile = "wife-nl-finance"): Finding => ({
  kind: "lane-silent",
  subject: profile,
  evidence: "0 new postings for 12 sweeps",
  severity: "medium",
});

let dir: string;
let file: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "jobhunt-notify-"));
  file = join(dir, "jobhunt-findings-state.json");
  delete process.env["FOUNDEROS_DATA_ROOT"];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("where the state lives", () => {
  it("defaults to the data root that survives deploys", () => {
    expect(notifyStatePath()).toBe("/opt/founderos-data/jobhunt-findings-state.json");
  });

  it("follows FOUNDEROS_DATA_ROOT, read at call time", () => {
    process.env["FOUNDEROS_DATA_ROOT"] = "/srv/data";
    expect(notifyStatePath()).toBe("/srv/data/jobhunt-findings-state.json");
  });
});

describe("the throttle", () => {
  it("tells a new decision immediately", () => {
    const { due, quiet } = partitionDecisions([notActing()], EMPTY_NOTIFY_STATE, T0);
    expect(due).toHaveLength(1);
    expect(quiet).toHaveLength(0);
  });

  it("does NOT repeat the same decision the next morning, or six days later", () => {
    const told = recordNotified(EMPTY_NOTIFY_STATE, [notActing()], T0);

    for (const days of [1, 3, DECISION_RENOTIFY_DAYS - 1]) {
      const { due, quiet } = partitionDecisions([notActing()], told, later(days));
      expect(due, `day ${days}`).toHaveLength(0);
      expect(quiet, `day ${days}`).toHaveLength(1);
    }
  });

  it("tells it again once 7 days have passed", () => {
    const told = recordNotified(EMPTY_NOTIFY_STATE, [notActing()], T0);
    expect(partitionDecisions([notActing()], told, later(DECISION_RENOTIFY_DAYS)).due).toHaveLength(1);
    expect(partitionDecisions([notActing()], told, later(DECISION_RENOTIFY_DAYS + 3)).due).toHaveLength(1);
  });

  it("notifies immediately when the fingerprint changes: another profile, or another kind", () => {
    const told = recordNotified(EMPTY_NOTIFY_STATE, [notActing()], T0);

    const other = partitionDecisions([notActing("pushkar-nl-tech"), laneSilent()], told, later(1));

    expect(other.due.map((f) => `${f.kind}:${f.subject}`).sort()).toEqual([
      "candidate-not-acting:pushkar-nl-tech",
      "lane-silent:wife-nl-finance",
    ]);
    expect(other.quiet).toHaveLength(0);
  });

  it("is keyed on the finding's own fingerprint, so changed numbers in the evidence do not re-notify", () => {
    const told = recordNotified(EMPTY_NOTIFY_STATE, [notActing()], T0);
    const sameDefect = { ...notActing(), evidence: "65 actionable roles, 0 applied" };

    expect(computeFingerprint(sameDefect)).toBe(computeFingerprint(notActing()));
    expect(partitionDecisions([sameDefect], told, later(2)).due).toHaveLength(0);
  });

  it("reports when the next reminder is due, so the line can say so", () => {
    const told = recordNotified(EMPTY_NOTIFY_STATE, [notActing()], T0);
    const { quiet } = partitionDecisions([notActing()], told, later(2));
    expect(quiet[0]!.nextReminderAt.toISOString()).toBe(later(DECISION_RENOTIFY_DAYS).toISOString());
  });

  it("a finding that disappears for a day and returns inside the window is not re-announced", () => {
    // Flicker around the 20-row floor must not turn into a message a day.
    const told = recordNotified(EMPTY_NOTIFY_STATE, [notActing()], T0);
    const gone = partitionDecisions([], told, later(1));
    expect(gone.due).toHaveLength(0);
    expect(partitionDecisions([notActing()], told, later(2)).due).toHaveLength(0);
  });

  it("recordNotified is pure: it returns a new state and leaves its input alone", () => {
    const before = JSON.stringify(EMPTY_NOTIFY_STATE);
    const next = recordNotified(EMPTY_NOTIFY_STATE, [notActing()], T0);
    expect(JSON.stringify(EMPTY_NOTIFY_STATE)).toBe(before);
    expect(next).not.toBe(EMPTY_NOTIFY_STATE);
  });

  it("drops entries older than the window so the file cannot grow forever", () => {
    const old = recordNotified(EMPTY_NOTIFY_STATE, [notActing("old-profile")], T0);
    const next = recordNotified(old, [notActing()], later(DECISION_RENOTIFY_DAYS + 1));
    expect(Object.keys(next.decisions)).toEqual([computeFingerprint(notActing())]);
  });
});

describe("loading the state file", () => {
  it("round-trips what was saved", async () => {
    const state = recordNotified(EMPTY_NOTIFY_STATE, [notActing(), laneSilent()], T0);
    await saveNotifyState(state, file);
    expect(await loadNotifyState(file)).toEqual(state);
  });

  it("MISSING: starts empty and warns once", async () => {
    const state = await loadNotifyState(join(dir, "does-not-exist.json"));

    expect(state).toEqual(EMPTY_NOTIFY_STATE);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("CORRUPT (not JSON): starts empty and warns once, naming the file", async () => {
    writeFileSync(file, "{ this is not json");

    const state = await loadNotifyState(file);

    expect(state).toEqual(EMPTY_NOTIFY_STATE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain(file);
  });

  it("CORRUPT (valid JSON, wrong shape): starts empty rather than trusting it", async () => {
    writeFileSync(file, JSON.stringify({ version: 1, decisions: { abc: { lastNotifiedAt: "not a date" } } }));

    expect(await loadNotifyState(file)).toEqual(EMPTY_NOTIFY_STATE);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an unknown future version is not trusted either", async () => {
    writeFileSync(file, JSON.stringify({ version: 2, decisions: {} }));
    expect(await loadNotifyState(file)).toEqual(EMPTY_NOTIFY_STATE);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a healthy file warns about nothing", async () => {
    await saveNotifyState(recordNotified(EMPTY_NOTIFY_STATE, [notActing()], T0), file);
    await loadNotifyState(file);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a lost file degrades to telling again, never to silence: the decision is due", async () => {
    const state = await loadNotifyState(join(dir, "gone.json"));
    expect(partitionDecisions([notActing()], state, T0).due).toHaveLength(1);
  });
});

describe("saving the state file", () => {
  it("creates the data directory when it does not exist yet", async () => {
    const nested = join(dir, "a", "b", "state.json");
    await saveNotifyState(recordNotified(EMPTY_NOTIFY_STATE, [notActing()], T0), nested);
    expect(existsSync(nested)).toBe(true);
  });

  it("writes atomically: overlapping saves leave one complete file and no temp litter", async () => {
    const states = Array.from({ length: 12 }, (_, i) =>
      recordNotified(EMPTY_NOTIFY_STATE, [notActing(`profile-${i}`)], later(i)),
    );

    await Promise.all(states.map((s) => saveNotifyState(s, file)));

    // Last writer wins, whichever it was; what matters is the file is never torn.
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version: number; decisions: Record<string, unknown> };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.decisions)).toHaveLength(1);
    expect(states.map((s) => JSON.stringify(s))).toContain(JSON.stringify(parsed));
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("a failed save throws instead of pretending, and leaves no temp file behind", async () => {
    // A directory where the file should go makes the rename fail.
    const blocked = join(dir, "blocked.json");
    rmSync(blocked, { force: true });
    writeFileSync(join(dir, "x"), "");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(blocked);

    await expect(saveNotifyState(recordNotified(EMPTY_NOTIFY_STATE, [notActing()], T0), blocked)).rejects.toThrow();
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
