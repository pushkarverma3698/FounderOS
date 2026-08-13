/**
 * drizzle/0029_lesson_occurrence_tracking.sql — structural checks.
 * ==================================================================
 * No reachable Postgres in this environment (no DATABASE_URL), so this test
 * cannot run the migration live. What it CAN and does verify statically:
 *
 *   1. The forward file adds exactly the four documented columns, and its
 *      backfill UPDATE is gated on `migrated_from_v1 IS NOT TRUE` — the
 *      guard that makes a second run of this file a no-op (idempotent):
 *      once a row's migrated_from_v1 flips to true, the WHERE clause excludes
 *      it from ever being backfilled again, so times_resolved/first_seen_at/
 *      last_seen_at can't be double-counted or clobbered by a re-run.
 *   2. The down file drops exactly those same four columns and nothing else
 *      — a clean inverse.
 *
 * A live-Postgres run of both directions (apply, apply again, diff — then
 * revert, diff against a pre-migration snapshot) is the documented manual
 * check in the SQL files' own header comments (`psql "$DATABASE_URL" -f …`),
 * to be run once a reachable database exists (NOT VERIFIED in this session —
 * see the PR body).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DRIZZLE_DIR = fileURLToPath(new URL("../../../drizzle/", import.meta.url));
const FORWARD = readFileSync(`${DRIZZLE_DIR}0029_lesson_occurrence_tracking.sql`, "utf8");
const DOWN = readFileSync(`${DRIZZLE_DIR}0029_lesson_occurrence_tracking.down.sql`, "utf8");

const ADDED_COLUMNS = ["times_resolved", "first_seen_at", "last_seen_at", "migrated_from_v1"];

describe("drizzle/0029_lesson_occurrence_tracking — forward migration", () => {
  it("adds exactly the four documented columns via ADD COLUMN IF NOT EXISTS", () => {
    for (const col of ADDED_COLUMNS) {
      expect(FORWARD).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`));
    }
    // Every ADD COLUMN clause in the file is one of the four — nothing extra snuck in.
    const clauses = [...FORWARD.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(new Set(clauses)).toEqual(new Set(ADDED_COLUMNS));
  });

  it("the backfill UPDATE is gated on migrated_from_v1, so re-running the file is a no-op", () => {
    const updateMatch = /UPDATE\s+agents\.failure_lessons\s+SET([\s\S]*?)WHERE\s+([\s\S]*?);/i.exec(FORWARD);
    expect(updateMatch, "expected exactly one backfill UPDATE statement").toBeTruthy();
    const [, setClause, whereClause] = updateMatch!;

    // The guard: only untouched rows (migrated_from_v1 IS NOT TRUE) qualify —
    // a second run finds zero matching rows and changes nothing.
    expect(whereClause).toMatch(/migrated_from_v1\s+is\s+not\s+true/i);

    // The row itself flips the flag it's gated on, so it can never re-match.
    expect(setClause).toMatch(/migrated_from_v1\s*=\s*true/i);

    // The exact backfill mapping the brief specifies.
    expect(setClause).toMatch(/times_resolved\s*=\s*times_seen/i);
    expect(setClause).toMatch(/first_seen_at\s*=\s*created_at/i);
    expect(setClause).toMatch(/last_seen_at\s*=\s*last_resolved_at/i);
  });

  it("there is exactly one UPDATE statement (no second, ungated backfill path)", () => {
    const updates = [...FORWARD.matchAll(/^UPDATE\s+agents\.failure_lessons/gim)];
    expect(updates).toHaveLength(1);
  });
});

describe("drizzle/0029_lesson_occurrence_tracking.down — inverse", () => {
  it("drops exactly the four columns the forward file added, nothing else", () => {
    const dropped = [...DOWN.matchAll(/DROP COLUMN IF EXISTS (\w+)/g)].map((m) => m[1]);
    expect(new Set(dropped)).toEqual(new Set(ADDED_COLUMNS));
    expect(dropped).toHaveLength(ADDED_COLUMNS.length);
  });

  it("touches only the failure_lessons table", () => {
    const alterTargets = [...DOWN.matchAll(/ALTER TABLE (\S+)/g)].map((m) => m[1]);
    expect(new Set(alterTargets)).toEqual(new Set(["agents.failure_lessons"]));
  });

  it("is documented as manual-apply-only (no automated runner claims it)", () => {
    expect(DOWN).toMatch(/by hand|manual/i);
    expect(DOWN).toMatch(/psql/);
  });
});
