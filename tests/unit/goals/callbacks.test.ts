/**
 * Button payloads. Telegram rejects a WHOLE keyboard when one callback_data exceeds 64 bytes, and a
 * UUID alone is 36 — so a goal id travels as 22 characters of base64url, and a payload that would not
 * fit is never built (no button beats a keyboard Telegram refuses).
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CALLBACK_DATA_MAX_BYTES,
  GOAL_CALLBACK_PREFIX,
  decodeGoalCallback,
  decodeGoalId,
  encodeGoalCallback,
  encodeGoalId,
  type GoalCallback,
} from "../../../src/goals/callbacks.js";
import { METRIC_KEYS } from "../../../src/goals/metrics.js";

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

describe("encodeGoalId / decodeGoalId — a UUID in 22 characters", () => {
  it("is 22 characters, against the UUID's 36", () => {
    const id = randomUUID();
    const token = encodeGoalId(id);
    expect(id).toHaveLength(36);
    expect(token).toHaveLength(22);
  });

  it("round-trips 200 random UUIDs exactly", () => {
    for (let i = 0; i < 200; i++) {
      const id = randomUUID();
      expect(decodeGoalId(encodeGoalId(id)!)).toBe(id);
    }
  });

  it("normalises an upper-case UUID to the canonical lower-case one", () => {
    const id = "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";
    expect(decodeGoalId(encodeGoalId(id)!)).toBe(id.toLowerCase());
  });

  it("refuses anything that is not a UUID", () => {
    for (const bad of ["", "abc", "not-a-uuid-at-all-not-a-uuid-at-all-x", "0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d", "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4g"]) {
      expect(encodeGoalId(bad), bad).toBeNull();
    }
  });

  it("refuses a token of the wrong length, alphabet or non-canonical padding bits", () => {
    const good = encodeGoalId(randomUUID())!;
    for (const bad of ["", good.slice(1), `${good}A`, `${good.slice(0, 21)}!`, `${good.slice(0, 21)}=`, "A".repeat(22).replace(/A$/, "B")]) {
      // "AAAA…B" decodes to bytes that re-encode differently, so it is not a token this code issued.
      expect(decodeGoalId(bad), bad).toBeNull();
    }
  });
});

describe("encodeGoalCallback / decodeGoalCallback", () => {
  const goalId = randomUUID();
  const everyKind: GoalCallback[] = [
    { kind: "plan", goalId },
    ...METRIC_KEYS.map((family): GoalCallback => ({ kind: "metric", family })),
    { kind: "arg", family: "applications_7d", arg: "wife-nl-finance" },
    { kind: "arg", family: "prs_merged_7d", arg: "pushkarverma3698/House-of-Hulda-Website-frontend" },
  ];

  it("keeps the payload of every button well under Telegram's 64-byte limit", () => {
    for (const cb of everyKind) {
      const data = encodeGoalCallback(cb);
      expect(data, JSON.stringify(cb)).not.toBeNull();
      expect(bytes(data!)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
    expect(bytes(encodeGoalCallback({ kind: "plan", goalId })!)).toBeLessThan(40);
  });

  it("round-trips every kind", () => {
    for (const cb of everyKind) expect(decodeGoalCallback(encodeGoalCallback(cb)!)).toEqual(cb);
  });

  it("builds nothing for a payload that would not fit, rather than a truncated or oversized one", () => {
    expect(encodeGoalCallback({ kind: "arg", family: "prs_merged_7d", arg: `owner/${"r".repeat(90)}` })).toBeNull();
    expect(encodeGoalCallback({ kind: "plan", goalId: "not-a-uuid" })).toBeNull();
    expect(encodeGoalCallback({ kind: "arg", family: "manual", arg: "has space" })).toBeNull();
  });

  it("lives under its own prefix, which no other button handler claims", () => {
    for (const cb of everyKind) {
      const data = encodeGoalCallback(cb)!;
      expect(data.startsWith(GOAL_CALLBACK_PREFIX)).toBe(true);
      for (const other of ["approve", "reject", "task:repo:", "retry:", "menu:"]) expect(data.startsWith(other), `${data} vs ${other}`).toBe(false);
    }
  });

  it("treats a payload from outside as untrusted input and refuses whatever is malformed", () => {
    const good = encodeGoalCallback({ kind: "plan", goalId })!;
    for (const bad of [
      "",
      "goal:",
      "goal:x:1",
      "goal:p:",
      "goal:p:short",
      `${good}:extra`,
      "goal:m:9",
      "goal:m:-1",
      "goal:m:x",
      "goal:m:1:2",
      "goal:a:1",
      "goal:a:1:has space",
      "goal:a:9:wife-nl-finance",
      "task:repo:FounderOS",
      "approve:abc",
    ]) {
      expect(decodeGoalCallback(bad), bad).toBeNull();
    }
  });
});
