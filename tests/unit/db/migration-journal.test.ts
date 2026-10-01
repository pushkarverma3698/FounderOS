/**
 * Migration journal contract — the drizzle "silent skip" trap.
 * =============================================================
 * drizzle's migrator does NOT apply "every migration not yet recorded". It reads
 * the newest `created_at` in drizzle.__drizzle_migrations and runs only journal
 * entries whose `when` is GREATER than that. So an entry whose `when` is lower
 * than an already-applied one is skipped on that database, silently, forever,
 * while a fresh database (CI, a new laptop) applies it fine. The founder recorded
 * exactly this on 2026-09-08: 0040_ats_board_cache carries a `when` LOWER than
 * 0039's, so a database that had already run 0039 never got the table.
 *
 * 0040 is grandfathered (its row exists everywhere it matters and rewriting a
 * shipped journal entry changes nothing for databases that already recorded it).
 * Every entry from FIRST_ENFORCED_IDX on must be strictly newer than everything
 * before it, so the class cannot recur unnoticed.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schemaModule from "../../../src/db/schema.js";

const DRIZZLE_DIR = fileURLToPath(new URL("../../../drizzle/", import.meta.url));

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** The first migration the strictly-increasing `when` rule is enforced from. */
const FIRST_ENFORCED_IDX = 42;
/** The one historical violation (0040 sits below 0039). Adding another fails the test below. */
const GRANDFATHERED_IDX = [40];

const journal = JSON.parse(readFileSync(`${DRIZZLE_DIR}meta/_journal.json`, "utf8")) as { entries: JournalEntry[] };
const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

/** Largest `when` among entries strictly before `idx`. */
const maxWhenBefore = (idx: number): number =>
  entries.filter((e) => e.idx < idx).reduce((max, e) => Math.max(max, e.when), 0);

describe("drizzle journal — every entry names a real migration", () => {
  it("has contiguous indexes and each tag is its zero-padded index plus a name", () => {
    entries.forEach((entry, position) => {
      expect(entry.idx, `entry ${entry.tag}`).toBe(position);
      expect(entry.tag.startsWith(`${String(entry.idx).padStart(4, "0")}_`), entry.tag).toBe(true);
    });
  });

  it("has a .sql file on disk whose name equals the tag, for every entry", () => {
    const missing = entries.filter((e) => !existsSync(`${DRIZZLE_DIR}${e.tag}.sql`)).map((e) => e.tag);
    expect(missing).toEqual([]);
  });
});

describe("drizzle journal — `when` never goes backwards (the silent-skip trap)", () => {
  it("only the grandfathered entry sits at or below an earlier entry's `when`", () => {
    const backwards = entries.filter((e) => e.when <= maxWhenBefore(e.idx)).map((e) => e.idx);
    expect(backwards).toEqual(GRANDFATHERED_IDX);
  });

  it("gives every entry from 0042 on a `when` strictly greater than all earlier entries", () => {
    const offenders = entries
      .filter((e) => e.idx >= FIRST_ENFORCED_IDX && e.when <= maxWhenBefore(e.idx))
      .map((e) => `${e.tag}: when ${e.when} <= ${maxWhenBefore(e.idx)} — drizzle would skip it on a database that already ran a newer migration`);
    expect(offenders).toEqual([]);
  });
});

describe("0042_goals — the goals migration", () => {
  const entry = entries.find((e) => e.tag === "0042_goals");
  const sqlPath = `${DRIZZLE_DIR}0042_goals.sql`;

  it("is registered in the journal as index 42", () => {
    expect(entry, "0042_goals is missing from drizzle/meta/_journal.json").toBeDefined();
    expect(entry?.idx).toBe(42);
  });

  it("is the newest entry, with a `when` above the largest of all 42 earlier entries", () => {
    expect(entry).toBeDefined();
    expect(entry!.when).toBeGreaterThan(maxWhenBefore(42));
    expect(entries.at(-1)?.tag).toBe("0042_goals");
  });

  it("has a `when` that is a real millisecond epoch, not a placeholder", () => {
    expect(entry).toBeDefined();
    // 2026-09-29 is 1.79e12 ms; a seconds-since-epoch value or a hand-typed round number would miss this window.
    expect(entry!.when).toBeGreaterThan(1_790_000_000_000);
    expect(Number.isInteger(entry!.when)).toBe(true);
  });

  it("uses only re-runnable DDL: every CREATE is IF NOT EXISTS and nothing is dropped", () => {
    const sql = readFileSync(sqlPath, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .toLowerCase();
    const creates = [...sql.matchAll(/create\s+(?:unique\s+)?(table|index)\s+(?!if\s+not\s+exists)/g)];
    expect(creates.map((m) => m[0]), "a CREATE without IF NOT EXISTS fails on the second run").toEqual([]);
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|constraint)\b/);
    expect(sql).toMatch(/create table if not exists "agents"\."goals"/);
    expect(sql).toMatch(/create table if not exists "agents"\."goal_reviews"/);
  });

  it("does not ship a .down.sql — recent migrations (0030-0041) do not, only 0029 did", () => {
    expect(existsSync(`${DRIZZLE_DIR}0042_goals.down.sql`)).toBe(false);
  });
});

describe("goals tables are visible to the schema ⇄ migration parity guard", () => {
  // schema-migration-parity.test.ts compares the tables exported from src/db/schema.ts with
  // the columns the migrations create. A table declared elsewhere and never re-exported
  // there is invisible to it: the 2026-07-29 `recurrence` incident, waiting to repeat.
  const declared = new Map<string, Set<string>>();
  for (const value of Object.values(schemaModule)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    declared.set(`${cfg.schema ?? "public"}.${cfg.name}`, new Set(cfg.columns.map((c) => c.name)));
  }

  it("exports agents.goals with the plan's columns plus the documented manual-value pair", () => {
    const cols = declared.get("agents.goals");
    expect(cols, "agents.goals is not exported from src/db/schema.ts").toBeDefined();
    for (const c of [
      "id", "tenant_id", "title", "metric_key", "metric_arg", "target", "baseline", "due_on", "status",
      "blocked_until", "blocker", "priority", "created_at", "updated_at", "manual_value", "manual_value_at",
    ]) {
      expect(cols!.has(c), `agents.goals.${c}`).toBe(true);
    }
  });

  it("exports agents.goal_reviews with the plan's columns plus the two-phase claim columns", () => {
    const cols = declared.get("agents.goal_reviews");
    expect(cols, "agents.goal_reviews is not exported from src/db/schema.ts").toBeDefined();
    for (const c of ["goal_id", "review_date", "value", "evidence", "pace", "error", "claimed_at", "sent_at", "attempts"]) {
      expect(cols!.has(c), `agents.goal_reviews.${c}`).toBe(true);
    }
  });
});
