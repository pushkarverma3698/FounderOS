/**
 * Pre-tailoring: the top apply-today roles get their CV and cover letter BEFORE the founder taps Draft.
 * Prod 2026-10-05: 2 applications ever, 5 of 4,456 rows with a tailored CV, because tailoring only ran when a
 * button was tapped and took 20-40 s. These tests pin the rules that keep the daily step cheap and safe:
 * a cap per profile, one run per profile per day, a stop when the day's budget is spent, failures that are not
 * retried every morning, and nothing that sends. Every model call is a fake, so this file costs nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../../src/infra/logger.js", () => ({ childLogger: () => logs }));

import {
  PRETAILOR_PER_PROFILE_CAP,
  pretailorAuditKey,
  pretailorRow,
  runPretailor,
  selectPretailorRows,
  type PretailorDeps,
  type PretailorRowDeps,
  type PretailorRowInput,
} from "../../../src/tools/jobhunt/pretailor.js";
import { COMPACT_ROLE_COUNT } from "../../../src/gateway/jobhunt-compact.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";

const row = (n: number, over: Partial<PretailorRowInput> = {}): PretailorRowInput => ({
  id: "00000000-0000-4000-8000-" + String(n).padStart(12, "0"),
  company: "Company " + n,
  title: "Engineer " + n,
  brief_section: "do_today",
  tailor_status: null,
  tailored_cv_s3_key: null,
  cover_letter_s3_key: null,
  ...over,
});

const PROFILES = [
  { id: "pushkar-nl-tech", tenantId: "turicks" },
  { id: "wife-nl-finance", tenantId: "turicks" },
] as unknown as readonly JobSearchProfile[];

const NOW = new Date("2026-10-06T04:30:00Z");

/** Deps where every step succeeds; each test overrides only what it is about. */
function fakeDeps(queues: Record<string, readonly PretailorRowInput[]>, over: Partial<PretailorDeps> = {}) {
  const recorded: Array<{ key: string; summary: { attempted: number; stored: number; failed: number } }> = [];
  const tailored: string[] = [];
  const deps: PretailorDeps = {
    profiles: () => PROFILES,
    refreshRanks: vi.fn(async () => undefined),
    listQueue: async (p) => queues[p.id] ?? [],
    budgetAllows: async () => ({ ok: true }),
    alreadyRan: async () => false,
    recordRun: async (key, _profile, summary) => {
      recorded.push({ key, summary });
    },
    tailorRow: async (r) => {
      tailored.push(r.id);
      return { ok: true };
    },
    now: () => NOW,
    ...over,
  };
  return { deps, recorded, tailored };
}

beforeEach(() => vi.clearAllMocks());

describe("selectPretailorRows", () => {
  it("takes the roles the brief card shows, best rank first, and no more than the cap", () => {
    const queue = [row(1), row(2), row(3), row(4), row(5)];
    expect(selectPretailorRows(queue).map((r) => r.company)).toEqual(["Company 1", "Company 2", "Company 3"]);
    expect(PRETAILOR_PER_PROFILE_CAP).toBe(COMPACT_ROLE_COUNT);
  });
  it("skips a role that already has a stored CV", () => {
    const queue = [row(1, { tailored_cv_s3_key: "k1" }), row(2)];
    expect(selectPretailorRows(queue).map((r) => r.company)).toEqual(["Company 2"]);
  });
});
describe("selectPretailorRows: what it leaves alone", () => {
  it("only looks at the roles the card shows, so a fourth role is never paid for", () => {
    const stored = { tailored_cv_s3_key: "k" };
    const queue = [row(1, stored), row(2, stored), row(3, stored), row(4)];
    expect(selectPretailorRows(queue)).toEqual([]);
  });
});
describe("selectPretailorRows: more rules", () => {
  it("ignores roles outside DO TODAY", () => {
    const queue = [row(1, { brief_section: "stretch" }), row(2, { brief_section: "standing" }), row(3)];
    expect(selectPretailorRows(queue).map((r) => r.company)).toEqual(["Company 3"]);
  });
  it("does not retry a role that failed, or one being tailored right now", () => {
    const queue = [row(1, { tailor_status: "failed" }), row(2, { tailor_status: "tailoring" }), row(3)];
    expect(selectPretailorRows(queue).map((r) => r.company)).toEqual(["Company 3"]);
  });
  it("retries a role marked tailored whose CV never reached storage", () => {
    const queue = [row(1, { tailor_status: "tailored", tailored_cv_s3_key: null })];
    expect(selectPretailorRows(queue)).toHaveLength(1);
  });
});

describe("pretailorAuditKey", () => {
  it("is one key per profile per local day", () => {
    const a = pretailorAuditKey("pushkar-nl-tech", NOW, "Asia/Kolkata");
    expect(a).toBe("jobhunt_pretailor:pushkar-nl-tech:2026-10-06");
    expect(pretailorAuditKey("wife-nl-finance", NOW, "Asia/Kolkata")).not.toBe(a);
    const late = new Date("2026-10-06T20:00:00Z");
    expect(pretailorAuditKey("pushkar-nl-tech", late, "Asia/Kolkata")).toBe("jobhunt_pretailor:pushkar-nl-tech:2026-10-07");
  });
});

describe("runPretailor", () => {
  it("tailors the top three roles of each profile, never more, and records one run per profile", async () => {
    const many = [row(1), row(2), row(3), row(4), row(5)];
    const { deps, recorded, tailored } = fakeDeps({ "pushkar-nl-tech": many, "wife-nl-finance": [row(11), row(12)] });
    const out = await runPretailor(deps);
    expect(tailored).toHaveLength(5);
    expect(tailored.filter((id) => many.some((m) => m.id === id))).toHaveLength(3);
    expect(out.map((o) => [o.profileId, o.attempted, o.stored, o.failed])).toEqual([["pushkar-nl-tech", 3, 3, 0], ["wife-nl-finance", 2, 2, 0]]);
    expect(recorded.map((r) => r.key)).toEqual(["jobhunt_pretailor:pushkar-nl-tech:2026-10-06", "jobhunt_pretailor:wife-nl-finance:2026-10-06"]);
  });
  it("ranks the queue before choosing, because overnight rows carry no rank yet", async () => {
    const { deps } = fakeDeps({ "pushkar-nl-tech": [row(1)] });
    await runPretailor(deps);
    expect(deps.refreshRanks).toHaveBeenCalledTimes(2);
  });
  it("a second run the same day tailors nothing and does not even rank", async () => {
    const { deps, tailored } = fakeDeps({ "pushkar-nl-tech": [row(1)] }, { alreadyRan: async () => true });
    const out = await runPretailor(deps);
    expect(tailored).toEqual([]);
    expect(deps.refreshRanks).not.toHaveBeenCalled();
    expect(out.every((o) => o.status === "already-ran")).toBe(true);
  });
  it("skips cleanly with one log line when the daily budget is spent", async () => {
    const { deps, tailored, recorded } = fakeDeps({ "pushkar-nl-tech": [row(1)], "wife-nl-finance": [row(11)] }, { budgetAllows: async () => ({ ok: false, reason: "Daily budget exceeded" }) });
    const out = await runPretailor(deps);
    expect(tailored).toEqual([]);
    expect(recorded).toEqual([]);
    expect(out.every((o) => o.status === "budget-exhausted")).toBe(true);
    expect(logs.warn).toHaveBeenCalledTimes(1);
  });
  it("stops the whole run mid-way when the budget runs out, and leaves the day open", async () => {
    let calls = 0;
    const budgetAllows = async () => (++calls <= 1 ? { ok: true as const } : { ok: false as const, reason: "spent" });
    const { deps, tailored, recorded } = fakeDeps({ "pushkar-nl-tech": [row(1), row(2)], "wife-nl-finance": [row(11)] }, { budgetAllows });
    await runPretailor(deps);
    expect(tailored).toHaveLength(1);
    expect(recorded).toEqual([]);
    expect(logs.warn).toHaveBeenCalledTimes(1);
  });
  it("counts a failed role, keeps going, and still records the run", async () => {
    const { deps, recorded } = fakeDeps({ "pushkar-nl-tech": [row(1), row(2), row(3)] }, { tailorRow: async (r) => (r.company === "Company 2" ? { ok: false, reason: "no description" } : { ok: true }) });
    const out = await runPretailor(deps);
    expect(out[0]).toMatchObject({ attempted: 3, stored: 2, failed: 1, status: "ran" });
    expect(recorded[0]?.summary).toEqual({ attempted: 3, stored: 2, failed: 1 });
  });
  it("treats a throwing tailor step as a failed role, not a crashed run", async () => {
    const { deps } = fakeDeps({ "pushkar-nl-tech": [row(1)], "wife-nl-finance": [row(11)] }, { tailorRow: async () => { throw new Error("chromium died"); } });
    const out = await runPretailor(deps);
    expect(out.map((o) => o.failed)).toEqual([1, 1]);
  });
  it("a profile whose ranking fails is skipped and the other profile still runs", async () => {
    const refreshRanks = vi.fn(async (p: { id: string }) => { if (p.id === "pushkar-nl-tech") throw new Error("db down"); });
    const { deps, tailored } = fakeDeps({ "pushkar-nl-tech": [row(1)], "wife-nl-finance": [row(11)] }, { refreshRanks });
    const out = await runPretailor(deps);
    expect(out.map((o) => o.status)).toEqual(["rank-failed", "ran"]);
    expect(tailored).toHaveLength(1);
  });
  it("says so when there is nothing to tailor, and records that too", async () => {
    const { deps, recorded } = fakeDeps({});
    const out = await runPretailor(deps);
    expect(out.every((o) => o.status === "nothing-to-do")).toBe(true);
    expect(recorded).toHaveLength(2);
  });
});

function rowDeps(over: Partial<PretailorRowDeps> = {}) {
  const calls: string[] = [];
  const deps: PretailorRowDeps = {
    buildPacket: async () => { calls.push("build"); return { ok: true, cvMarkdown: "# CV" }; },
    cvStored: async () => true,
    writeLetter: async (_r, md) => { calls.push("letter:" + md); return { ok: true }; },
    markFailed: async (_id, reason) => { calls.push("failed:" + reason); },
    ...over,
  };
  return { deps, calls };
}

describe("pretailorRow", () => {
  it("builds the CV the Draft button builds, then writes the letter from that CV", async () => {
    const { deps, calls } = rowDeps();
    expect(await pretailorRow(row(1), deps)).toEqual({ ok: true });
    expect(calls).toEqual(["build", "letter:# CV"]);
  });
  it("marks a role failed when the CV cannot be built, and pays for no letter", async () => {
    const { deps, calls } = rowDeps({ buildPacket: async () => ({ ok: false, reason: "no usable description" }) });
    expect(await pretailorRow(row(1), deps)).toEqual({ ok: false, reason: "no usable description" });
    expect(calls).toEqual(["failed:no usable description"]);
  });
  it("pays for no letter when the CV never reached storage, and leaves the role open for tomorrow", async () => {
    const { deps, calls } = rowDeps({ cvStored: async () => false });
    const res = await pretailorRow(row(1), deps);
    expect(res.ok).toBe(false);
    expect(calls).toEqual(["build"]);
  });
  it("a missing letter costs the letter, not the CV", async () => {
    const { deps } = rowDeps({ writeLetter: async () => ({ ok: false, reason: "slop" }) });
    expect(await pretailorRow(row(1), deps)).toEqual({ ok: true });
    expect(logs.warn).toHaveBeenCalledTimes(1);
  });
});

describe("what leaves the system", () => {
  const src = (name: string) => readFileSync(fileURLToPath(new URL("../../../src/tools/jobhunt/" + name, import.meta.url)), "utf8");
  const importsOf = (text: string) => text.split("\n").filter((l) => /^(import|export) .* from /.test(l) || /^\} from /.test(l));
  it("pre-tailoring modules import nothing that sends: no Telegram, email, LinkedIn, grammy or gateway", () => {
    for (const file of ["pretailor.ts", "pretailor-cron.ts", "cover-letter-write.ts"]) {
      const joined = importsOf(src(file)).join("\n");
      expect(joined, file).not.toMatch(/telegram|email|linkedin|grammy|gateway|deliver|outbound/i);
    }
  });
});
