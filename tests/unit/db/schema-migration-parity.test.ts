/**
 * Schema ⇄ migration parity contract.
 * ====================================
 * 2026-07-29 → 2026-08-10 incident: `scheduled_tasks.recurrence` was declared in
 * src/db/schema.ts (commit c53f6a6) and NEVER migrated. Every drizzle query that
 * emits an explicit column list (`.select()`, `.returning()`) died in production
 * with `column "recurrence" does not exist` — schedule_task, list_scheduled,
 * edit_scheduled and boot-time stranded-task recovery were dead for 11 days while
 * `pnpm gate` stayed green, because the unit suite runs against tests/helpers/
 * mock-db and never touches Postgres.
 *
 * The invariant this pins: a production-bound schema declaration must have
 * verifiable migration coverage. Mocks must not be the only source of database
 * correctness.
 *
 * It compares the REAL declared schema (drizzle's own table metadata, not a text
 * scrape) against the columns the migration corpus actually creates, replaying
 * drizzle/*.sql in journal order through CREATE TABLE / ADD COLUMN / RENAME TO /
 * SET SCHEMA. A column declared in TypeScript with no DDL behind it fails here.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schemaModule from "../../../src/db/schema.js";

const DRIZZLE_DIR = fileURLToPath(new URL("../../../drizzle/", import.meta.url));

/** Quoted-or-bare identifier, optionally schema-qualified. */
const QUALIFIED = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?`;
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;

/** Fragments inside CREATE TABLE (...) that declare a constraint, not a column. */
const TABLE_CONSTRAINT = /^(constraint|primary|unique|foreign|check|exclude|like)\b/i;

/**
 * Tables that exist in Postgres but are NOT ours to migrate — created by a
 * library at runtime. LangGraph's PostgresSaver owns its checkpoint tables and
 * runs its own setup(); our migrations only relocate them into the agents schema.
 */
const LIBRARY_OWNED = new Set(["agents.checkpoints", "agents.checkpoint_blobs", "agents.checkpoint_writes"]);

const unquote = (raw: string): string => raw.replace(/"/g, "").toLowerCase();

/** `agents.foo` / `"agents"."foo"` / `foo` → `agents.foo` / `public.foo`. */
function qualify(raw: string): string {
  const parts = raw.split(".");
  return parts.length === 2 ? `${unquote(parts[0]!)}.${unquote(parts[1]!)}` : `public.${unquote(parts[0]!)}`;
}

/** Extract the balanced `( … )` body starting at the open paren index. */
function balancedBody(sql: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(openIdx + 1, i);
  }
  throw new Error(`Unbalanced parentheses at index ${openIdx}`);
}

/** Split a CREATE TABLE body on commas that are not nested inside parens. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

/** Column names declared by a CREATE TABLE body (constraints skipped). */
function columnsOf(body: string): string[] {
  return splitTopLevel(body)
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && !TABLE_CONSTRAINT.test(f))
    .map((f) => unquote(new RegExp(`^(${IDENT})`).exec(f)?.[1] ?? ""))
    .filter((name) => name.length > 0);
}

/** SQL `--` line comments carry table names in prose; drop them before parsing. */
const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");

/** Apply one migration's DDL to the accumulated table→columns map. */
function applyMigration(sql: string, tables: Map<string, Set<string>>): void {
  const clean = stripComments(sql);

  const create = new RegExp(String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})\s*\(`, "gi");
  for (let m = create.exec(clean); m; m = create.exec(clean)) {
    const name = qualify(m[1]!);
    const cols = tables.get(name) ?? new Set<string>();
    for (const c of columnsOf(balancedBody(clean, create.lastIndex - 1))) cols.add(c);
    tables.set(name, cols);
  }

  const alter = new RegExp(String.raw`alter\s+table\s+(?:if\s+exists\s+)?(${QUALIFIED})([^;]*)`, "gi");
  for (let m = alter.exec(clean); m; m = alter.exec(clean)) {
    const name = qualify(m[1]!);
    const body = m[2] ?? "";
    const cols = tables.get(name) ?? new Set<string>();

    const addCol = new RegExp(String.raw`add\s+column\s+(?:if\s+not\s+exists\s+)?(${IDENT})`, "gi");
    for (let a = addCol.exec(body); a; a = addCol.exec(body)) cols.add(unquote(a[1]!));
    tables.set(name, cols);

    // Table-identity moves: the same physical table under a new key.
    const renamed = new RegExp(String.raw`rename\s+to\s+(${IDENT})`, "i").exec(body);
    const moved = new RegExp(String.raw`set\s+schema\s+(${IDENT})`, "i").exec(body);
    if (renamed || moved) {
      const schemaPart = moved ? unquote(moved[1]!) : name.split(".")[0]!;
      const namePart = renamed ? unquote(renamed[1]!) : name.split(".")[1]!;
      tables.delete(name);
      tables.set(`${schemaPart}.${namePart}`, cols);
    }
  }
}

/**
 * Replay every migration the journal actually applies, in journal order.
 * Reading the journal (not the directory listing) is deliberate: drizzle-kit only
 * runs tags present in _journal.json, so a .sql file missing from the journal is
 * INERT in production and must not count as coverage.
 */
function migratedColumns(): Map<string, Set<string>> {
  const journal = JSON.parse(readFileSync(`${DRIZZLE_DIR}meta/_journal.json`, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const tables = new Map<string, Set<string>>();
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    applyMigration(readFileSync(`${DRIZZLE_DIR}${entry.tag}.sql`, "utf8"), tables);
  }
  return tables;
}

/** Every table drizzle declares, keyed `schema.table` → physical column names. */
function declaredColumns(): Map<string, Set<string>> {
  const declared = new Map<string, Set<string>>();
  for (const value of Object.values(schemaModule)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    const key = `${(cfg.schema ?? "public").toLowerCase()}.${cfg.name.toLowerCase()}`;
    declared.set(key, new Set(cfg.columns.map((c) => c.name.toLowerCase())));
  }
  return declared;
}

describe("schema ⇄ migration parity", () => {
  const declared = declaredColumns();
  const migrated = migratedColumns();

  it("declares at least the tables this suite is meant to guard", () => {
    expect(declared.size).toBeGreaterThanOrEqual(20);
    expect(declared.has("agents.scheduled_tasks")).toBe(true);
  });

  it("every declared table is created by a migration", () => {
    const missing = [...declared.keys()].filter((t) => !LIBRARY_OWNED.has(t) && !migrated.has(t));
    expect(missing, `Tables declared in src/db/schema.ts with no CREATE TABLE migration: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("every declared column exists in the migration corpus", () => {
    const gaps: string[] = [];
    for (const [table, columns] of declared) {
      if (LIBRARY_OWNED.has(table)) continue;
      const applied = migrated.get(table);
      if (!applied) continue; // reported by the table-level test above
      for (const column of columns) if (!applied.has(column)) gaps.push(`${table}.${column}`);
    }
    expect(
      gaps,
      "Columns declared in src/db/schema.ts with no migration behind them — these fail in " +
        `production the moment drizzle emits an explicit column list: ${gaps.join(", ")}`,
    ).toEqual([]);
  });

  it("every migration file on disk is registered in the journal", () => {
    const journal = JSON.parse(readFileSync(`${DRIZZLE_DIR}meta/_journal.json`, "utf8")) as {
      entries: { tag: string }[];
    };
    const registered = new Set(journal.entries.map((e) => e.tag));
    const onDisk = readdirSync(DRIZZLE_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, ""));
    const inert = onDisk.filter((tag) => !registered.has(tag));
    expect(inert, `Migration files not in _journal.json are never applied: ${inert.join(", ")}`).toEqual([]);
  });
});
