/**
 * Fact sheet section of the saved-answers editor: markers per category, setFact saves and clears, bad input is a
 * 400, a stale baseVersion a 409, and a saved value reaches the filler (fact sheet source). Fake values only.
 */

import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BOT = "123456:TEST-bot-token";
const FOUNDER = "pushkar-nl-tech";
const WIFE = "wife-nl-finance";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getPgPool: () => ({ query: async () => ({ rows: [] }) }) }));

const { startJobsHealthServer } = await import("../../../src/jobs/health.js");
const { applyProfilePathFor, parseApplyProfile } = await import("../../../src/tools/jobhunt/apply-profile.js");
const { buildDefaultDossierMarkdown, candidateDossierPathFor } = await import("../../../src/tools/jobhunt/candidate-dossier.js");

function initData(userId: number, authDate = Math.floor(NOW / 1000) - 60, token = BOT): string {
  const fields: Record<string, string> = { auth_date: String(authDate), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const seedRaw = (first: string) => ({
  first_name: first,
  last_name: "Person",
  email: `${first.toLowerCase()}@example.com`,
  phone: "+31 6 00000000",
  answers: { work_authorization: "unknown", salary_floor_eur_year: 60000, notice_period_days: 30, willing_to_relocate: true },
});

describe("fact sheet editor", () => {
  let dir: string;
  let server: ReturnType<typeof startJobsHealthServer>;
  let base: string;
  const prev: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "founderos-fact-sheet-"));
    for (const k of ["APPLY_PROFILE_PATH", "FOUNDEROS_DATA_ROOT"]) prev[k] = process.env[k];
    process.env["FOUNDEROS_DATA_ROOT"] = dir;
    process.env["APPLY_PROFILE_PATH"] = path.join(dir, "apply-profile.json");
    const raw = seedRaw("Pushkar");
    fs.writeFileSync(applyProfilePathFor(FOUNDER), JSON.stringify(raw, null, 2));
    const parsed = parseApplyProfile(JSON.stringify(raw));
    if (!parsed.ok) throw new Error(parsed.reason);
    fs.writeFileSync(candidateDossierPathFor(FOUNDER), buildDefaultDossierMarkdown(parsed.profile));
    server = startJobsHealthServer(0, {
      now: () => NOW,
      env: { APPLY_LINK_SECRET: "s3cret-for-tests-0123456789abcdef", APPLY_LINK_BASE_URL: "https://apply.example.test", JOBS_BOT_TOKEN: BOT, JOBHUNT_SENDER_PROFILES: "111=pushkar" },
      root: dir,
    });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const load = async () => (await (await fetch(`${base}/apply/api/profile`, { headers: { "x-telegram-init-data": initData(111) } })).json()) as Record<string, any>;
  const post = (body: unknown) =>
    fetch(`${base}/apply/api/profile`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-init-data": initData(111) }, body: JSON.stringify(body) });
  const sheetOf = (): Record<string, string> => JSON.parse(fs.readFileSync(applyProfilePathFor(FOUNDER), "utf8")).answers.fact_sheet ?? {};

  it("lists every category with a blank or filled marker", async () => {
    const s = await load();
    const st = s.factSheet.status as Array<{ key: string; filled: boolean }>;
    expect(st.map((x) => x.key)).toEqual(expect.arrayContaining(["skill_years", "work_authorization", "referral_source", "salary", "notice", "eeo", "legal_name", "nationality", "languages", "address_line", "address_state", "postal_code"]));
    expect(st.find((x) => x.key === "salary")?.filled).toBe(true);
    expect(st.find((x) => x.key === "postal_code")?.filled).toBe(false);
    expect(s.factSheet.fields.map((f: any) => f.key)).toContain("postal_code");
  });

  it("setFact saves a field and a skill, shows them, and clears on empty", async () => {
    let s = await load();
    let r = await post({ op: "setFact", key: "postal_code", value: "1234 AB", baseVersion: s.version });
    expect(r.status).toBe(200);
    s = ((await r.json()) as Record<string, any>).state;
    r = await post({ op: "setFact", key: "skill_years.node-js", value: "3", baseVersion: s.version });
    expect(r.status).toBe(200);
    s = ((await r.json()) as Record<string, any>).state;
    expect(sheetOf()).toEqual({ postal_code: "1234 AB", "skill_years.node-js": "3" });
    expect(s.factSheet.skills).toEqual([{ skill: "node js", years: "3" }]);
    expect(s.factSheet.status.find((x: any) => x.key === "postal_code").filled).toBe(true);
    r = await post({ op: "setFact", key: "postal_code", value: "", baseVersion: s.version });
    expect(r.status).toBe(200);
    expect(sheetOf()).toEqual({ "skill_years.node-js": "3" });
  });

  it("refuses unknown keys, non-numeric skill years and a stale version", async () => {
    const s = await load();
    expect((await post({ op: "setFact", key: "salary_floor_eur_year", value: "1", baseVersion: s.version })).status).toBe(400);
    expect((await post({ op: "setFact", key: "skill_years.python", value: "lots", baseVersion: s.version })).status).toBe(400);
    expect((await post({ op: "setFact", key: "skill_years.Bad Key", value: "2", baseVersion: s.version })).status).toBe(400);
    expect((await post({ op: "setFact", key: "postal_code", value: "x", baseVersion: "stale" })).status).toBe(409);
    expect(sheetOf()).toEqual({});
  });
});
