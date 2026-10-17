import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPLY_LINK_TTL_MS,
  SNAPSHOT_MAX_AGE_MS,
  buildApplyUrl,
  deleteApplySnapshot,
  loadApplySnapshot,
  parseApplyToken,
  pruneApplySnapshots,
  readApplyLinkConfig,
  saveApplySnapshot,
  signApplyToken,
  verifyApplyToken,
  type ApplySnapshot,
} from "../../../src/tools/jobhunt/apply-link.js";

const SECRET = "s3cret-for-tests-0123456789abcdef";
const ROW = "11111111-2222-4333-8444-555555555555";
const ROW2 = "99999999-2222-4333-8444-555555555555";
const PROFILE = "fixture-profile";
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const EXP = Math.floor((NOW + APPLY_LINK_TTL_MS) / 1000);

function snap(over: Partial<ApplySnapshot> = {}): ApplySnapshot {
  return {
    rowId: ROW,
    chatId: "4242",
    profileId: PROFILE,
    company: "Acme BV",
    title: "Finance Analyst",
    candidateName: "Fixture Person",
    targetUrl: "https://jobs.example.com/acme/123",
    platform: "lever",
    resumePath: "/tmp/fixture-resume.pdf",
    summary: {
      filled: 2,
      total: 4,
      hasCaptcha: false,
      filledLabels: ["Full name", "Notice period"],
      filledAnswers: [
        { label: "Full name", value: "Fixture Person", fieldType: "text", editable: true },
        { label: "Notice period", value: "30 days", fieldType: "select", options: ["30 days", "60 days"], editable: true },
        { label: "Resume/CV", value: "cv-fixture.pdf", fieldType: "file", editable: false },
      ],
      unanswered: [
        { label: "Why Acme?", required: true, fieldType: "textarea" },
        { label: "Work permit", required: false, fieldType: "select", options: ["Yes", "No"], triedAnswer: "Yes" },
      ],
    },
    createdAt: NOW,
    ...over,
  };
}

describe("readApplyLinkConfig", () => {
  it("returns the secret and a trimmed base url without a trailing slash", () => {
    const cfg = readApplyLinkConfig({
      APPLY_LINK_SECRET: SECRET,
      APPLY_LINK_BASE_URL: "  https://host.example.net/  ",
    });
    expect(cfg).toEqual({ ok: true, secret: SECRET, baseUrl: "https://host.example.net" });
  });

  it("names the missing variable", () => {
    expect(readApplyLinkConfig({})).toEqual({ ok: false, reason: "APPLY_LINK_SECRET not set" });
    expect(readApplyLinkConfig({ APPLY_LINK_SECRET: SECRET })).toEqual({
      ok: false,
      reason: "APPLY_LINK_BASE_URL not set",
    });
  });

  it("rejects a short secret and a base url that is not http(s)", () => {
    expect(
      readApplyLinkConfig({ APPLY_LINK_SECRET: "short", APPLY_LINK_BASE_URL: "https://h.example" }),
    ).toEqual({ ok: false, reason: "APPLY_LINK_SECRET must be at least 16 characters" });
    expect(
      readApplyLinkConfig({ APPLY_LINK_SECRET: SECRET, APPLY_LINK_BASE_URL: "ftp://h.example" }),
    ).toEqual({ ok: false, reason: "APPLY_LINK_BASE_URL must be an http(s) URL" });
  });
});

describe("apply tokens", () => {
  it("round-trips for the same profile", () => {
    const token = signApplyToken(SECRET, ROW, PROFILE, EXP);
    expect(token.startsWith(`${ROW}.${EXP}.`)).toBe(true);
    expect(verifyApplyToken(SECRET, token, PROFILE, NOW)).toEqual({ ok: true, rowId: ROW, exp: EXP });
  });

  it("rejects a tampered signature, row, expiry or secret", () => {
    const token = signApplyToken(SECRET, ROW, PROFILE, EXP);
    const parts = token.split(".");
    const flipped = parts[2]!.slice(0, -1) + (parts[2]!.endsWith("A") ? "B" : "A");
    const bad = [
      `${parts[0]}.${parts[1]}.${flipped}`,
      `${ROW2}.${parts[1]}.${parts[2]}`,
      `${parts[0]}.${EXP + 1}.${parts[2]}`,
    ];
    for (const t of bad) {
      expect(verifyApplyToken(SECRET, t, PROFILE, NOW)).toEqual({ ok: false, reason: "bad-signature" });
    }
    expect(verifyApplyToken("another-secret-0123456789abcdef", token, PROFILE, NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("binds the token to the profile id", () => {
    const token = signApplyToken(SECRET, ROW, PROFILE, EXP);
    expect(verifyApplyToken(SECRET, token, "someone-else", NOW)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("reports expiry only after the signature is valid, and at the exact second", () => {
    const token = signApplyToken(SECRET, ROW, PROFILE, EXP);
    expect(verifyApplyToken(SECRET, token, PROFILE, EXP * 1000 - 1)).toMatchObject({ ok: true });
    expect(verifyApplyToken(SECRET, token, PROFILE, EXP * 1000)).toEqual({ ok: false, reason: "expired" });
    const forgedOld = `${ROW}.${EXP - 10}.${token.split(".")[2]}`;
    expect(verifyApplyToken(SECRET, forgedOld, PROFILE, EXP * 1000)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("treats malformed tokens as malformed", () => {
    const traversal = ["..", "..", "outside"].join("/");
    const cases = [
      "",
      "abc",
      "a.b",
      `${ROW}.notnum.sig`,
      `${ROW}.${EXP}.`,
      `${ROW}.${EXP}.sig.extra`,
      `${traversal}.${EXP}.abc`,
      `not-a-uuid.${EXP}.abc`,
    ];
    for (const t of cases) {
      expect(parseApplyToken(t)).toBeNull();
      expect(verifyApplyToken(SECRET, t, PROFILE, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("builds an absolute url from the config base", () => {
    const cfg = { ok: true as const, secret: SECRET, baseUrl: "https://host.example.net" };
    const url = buildApplyUrl(cfg, ROW, PROFILE, NOW);
    expect(url).toBe(`https://host.example.net/apply/${signApplyToken(SECRET, ROW, PROFILE, EXP)}`);
  });
});

describe("apply snapshot store", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-link-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const dirOf = () => path.join(root, "apply-pages");
  const fileOf = (id: string) => path.join(dirOf(), `${id}.json`);

  it("writes a private file atomically and round-trips", () => {
    saveApplySnapshot(snap(), root);
    expect(fs.statSync(fileOf(ROW)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirOf()).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dirOf())).toEqual([`${ROW}.json`]);
    expect(loadApplySnapshot(ROW, root)).toEqual(snap());
  });

  it("overwrites the previous snapshot for the same row", () => {
    saveApplySnapshot(snap(), root);
    saveApplySnapshot(snap({ company: "Other Co" }), root);
    expect(loadApplySnapshot(ROW, root)?.company).toBe("Other Co");
  });

  it("returns null for missing, corrupt, wrong-shape, mismatched and non-uuid ids", () => {
    expect(loadApplySnapshot(ROW, root)).toBeNull();
    fs.mkdirSync(dirOf(), { recursive: true });
    fs.writeFileSync(fileOf(ROW), "{not json");
    expect(loadApplySnapshot(ROW, root)).toBeNull();
    fs.writeFileSync(fileOf(ROW), JSON.stringify({ rowId: ROW }));
    expect(loadApplySnapshot(ROW, root)).toBeNull();
    fs.writeFileSync(fileOf(ROW), JSON.stringify(snap({ rowId: ROW2 })));
    expect(loadApplySnapshot(ROW, root)).toBeNull();
    expect(loadApplySnapshot("abc", root)).toBeNull();
    expect(loadApplySnapshot(["..", "..", "outside"].join("/"), root)).toBeNull();
  });

  it("refuses to save under a non-uuid row id", () => {
    expect(() => saveApplySnapshot(snap({ rowId: "not-a-uuid" }), root)).toThrow(/row id/);
  });

  it("deletes a snapshot and tolerates a missing one", () => {
    saveApplySnapshot(snap(), root);
    deleteApplySnapshot(ROW, root);
    expect(loadApplySnapshot(ROW, root)).toBeNull();
    expect(() => deleteApplySnapshot(ROW, root)).not.toThrow();
  });

  it("prunes only snapshots older than seven days", () => {
    saveApplySnapshot(snap(), root);
    saveApplySnapshot(snap({ rowId: ROW2 }), root);
    const old = (Date.now() - SNAPSHOT_MAX_AGE_MS - 60_000) / 1000;
    fs.utimesSync(fileOf(ROW), old, old);
    expect(pruneApplySnapshots(Date.now(), root)).toBe(1);
    expect(loadApplySnapshot(ROW, root)).toBeNull();
    expect(loadApplySnapshot(ROW2, root)).not.toBeNull();
  });
});

describe("snapshot filledAnswers", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "founderos-apply-link-filled-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("round-trips the filled answers, with their options and editable flag", () => {
    saveApplySnapshot(snap(), root);
    expect(loadApplySnapshot(ROW, root)).toEqual(snap());
  });

  it("loads a snapshot saved before filled answers existed, with an empty list", () => {
    const old = JSON.parse(JSON.stringify(snap())) as { summary: Record<string, unknown> };
    delete old.summary["filledAnswers"];
    const dir = path.join(root, "apply-pages");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ROW}.json`), JSON.stringify(old));
    const loaded = loadApplySnapshot(ROW, root);
    expect(loaded).not.toBeNull();
    expect(loaded?.summary.filledAnswers).toEqual([]);
    expect(loaded?.summary.filledLabels).toEqual(["Full name", "Notice period"]);
  });

  it("refuses a filled answer without the editable flag", () => {
    const bad = JSON.parse(JSON.stringify(snap())) as { summary: { filledAnswers: Record<string, unknown>[] } };
    delete bad.summary.filledAnswers[0]!["editable"];
    const dir = path.join(root, "apply-pages");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ROW}.json`), JSON.stringify(bad));
    expect(loadApplySnapshot(ROW, root)).toBeNull();
  });
});
