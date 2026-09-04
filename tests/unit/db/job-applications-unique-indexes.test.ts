/**
 * Every UNIQUE index on job_applications must be scoped by profile_id
 * ===================================================================
 * Written from a defect that only a live run could see, on 2026-09-04.
 *
 * `0036` correctly rebuilt `ja_dedupe_uniq` to include `profile_id` and missed
 * `ja_brief_rank_uniq`, which `0021` had created on
 * `(tenant_id, brief_section, brief_rank)`. Both candidates number their own
 * brief from 1, so the SECOND profile to rank collided on do_today rank 1 and
 * `recordBriefRanks` threw — every run, deterministically, forever.
 *
 * WHY NO OTHER LAYER CAUGHT IT. The application code was already correct:
 * `recordBriefRanks` and `getApplicationByBriefRank` both scope by profile.
 * The constraint lived only in SQL, the unit suite mocks the database, and the
 * write is wrapped in a tagged fail-open — so the brief rendered in full, the
 * founder read "1. Dyson — Lead VAT Accountant → /draft wife 1", and only the
 * numbers failed to save. `tsc`, 3,600 unit tests and six architecture ratchets
 * all stayed green.
 *
 * WHY THE TEST IS SHAPED THIS WAY. Asserting "0036 mentions profile_id twice"
 * would pass and prove nothing about the NEXT unique index someone adds. This
 * replays every migration's DDL in order, keeps the last definition of each
 * index, and then requires the whole surviving set to be profile-scoped. A new
 * unqualified UNIQUE index fails here on the commit that introduces it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DRIZZLE_DIR = fileURLToPath(new URL("../../../drizzle/", import.meta.url));

/** `CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON [schema.]job_applications (cols) [WHERE …]` */
const CREATE_INDEX =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(?:\w+\.)?job_applications\s*\(([^)]*)\)/gis;
const DROP_INDEX = /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:\w+\.)?(\w+)/gis;

interface IndexDef {
  readonly unique: boolean;
  readonly columns: readonly string[];
  readonly file: string;
}

/**
 * Replay the forward migrations in filename order and return the index set a
 * fresh database would end up with. `.down.sql` files are excluded: they are
 * the inverse, and folding them in would model a rollback nobody ran.
 */
function finalIndexes(): Map<string, IndexDef> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();

  const indexes = new Map<string, IndexDef>();
  for (const file of files) {
    const sql = readFileSync(`${DRIZZLE_DIR}${file}`, "utf8");

    for (const m of sql.matchAll(DROP_INDEX)) {
      indexes.delete((m[1] ?? "").toLowerCase());
    }
    for (const m of sql.matchAll(CREATE_INDEX)) {
      const name = (m[2] ?? "").toLowerCase();
      indexes.set(name, {
        unique: Boolean(m[1]),
        columns: (m[3] ?? "")
          .split(",")
          .map((c) => c.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
          .filter((c) => c.length > 0),
        file,
      });
    }
  }
  return indexes;
}

describe("job_applications unique indexes", () => {
  it("finds the indexes it is meant to be checking", () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously true — the exact way a guard like this rots into decoration.
    const indexes = finalIndexes();
    expect(indexes.has("ja_dedupe_uniq")).toBe(true);
    expect(indexes.has("ja_brief_rank_uniq")).toBe(true);
  });

  it("scopes EVERY unique index by profile_id", () => {
    const offenders = [...finalIndexes()]
      .filter(([, def]) => def.unique && !def.columns.includes("profile_id"))
      .map(([name, def]) => `${name} (${def.file}) -> (${def.columns.join(", ")})`);

    expect(
      offenders,
      "A unique index without profile_id lets one candidate's row block the " +
        "other's. Rebuild it in a migration with profile_id in the column list " +
        "— DROP then CREATE, because IF NOT EXISTS leaves a wrong definition in place.",
    ).toEqual([]);
  });

  it("keeps ja_brief_rank_uniq partial, so unranked rows never collide", () => {
    // Most rows have a NULL brief_section. Without the WHERE clause they would
    // all collide with each other the moment profile_id stops separating them.
    const sql = readFileSync(`${DRIZZLE_DIR}0036_jobhunt_profile.sql`, "utf8");
    const create = sql.slice(sql.lastIndexOf("CREATE UNIQUE INDEX ja_brief_rank_uniq"));
    expect(create).toMatch(/WHERE\s+brief_section\s+IS\s+NOT\s+NULL/i);
  });

  it("rebuilds ja_brief_rank_uniq with DROP first, not IF NOT EXISTS", () => {
    const sql = readFileSync(`${DRIZZLE_DIR}0036_jobhunt_profile.sql`, "utf8");
    expect(sql).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+agents\.ja_brief_rank_uniq/i);
    // The index already exists from 0021 with the wrong columns. `CREATE UNIQUE
    // INDEX IF NOT EXISTS` would find the name taken and skip — leaving the old
    // definition in place while the migration reports success.
    expect(sql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+ja_brief_rank_uniq/i);
  });
});
