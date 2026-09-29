/**
 * Every writer of agents.founder_context, listed, so a new one cannot skip the dates.
 * ===================================================================================
 * The row's values are only as trustworthy as their `context_meta` dates: a value
 * written with no date reads "date unknown", and one written with the wrong source
 * reads as confirmed by the founder when he never saw it. The dates are stamped where
 * the writes converge (queries.ts), but a writer that reaches the table another way
 * would skip them and nothing would say so. This test is the mechanism (CLAUDE.md
 * #27): it finds every file that can write the row and fails on one it does not know,
 * and it runs each known writer against an in-memory row to show what it leaves behind.
 *
 * To add a writer: send it through `upsertFounderContext(tenant, updates, source)`,
 * then add its file to KNOWN_WRITERS below with what it stamps. If it must write the
 * row without a date (a bookkeeping key), say why there; the reason is reviewed here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CONTEXT_META_KEY } from "../../../src/db/context-meta.js";
import { BUDGET_ALERTS_KEY } from "../../../src/infra/daily-budget.js";

const store = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined }));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (store.row ? [{ data: structuredClone(store.row) }] : []) }),
      }),
    }),
    insert: () => ({
      values: (v: { data: Record<string, unknown> }) => ({
        onConflictDoUpdate: async ({ set }: { set: { data: Record<string, unknown> } }) => {
          store.row = structuredClone(store.row ? set.data : v.data);
        },
      }),
    }),
  }),
}));

const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const NOW = new Date("2026-09-30T05:30:00.000Z");
const JUNE_AT = "2026-06-14T05:00:00.000Z";

/** Every file that can write the row, and what it leaves in context_meta. */
const KNOWN_WRITERS: Readonly<Record<string, string>> = {
  "src/db/queries.ts":
    "defines upsertFounderContext (stamps the source its caller names) and seedFounderContextDefaults (stamps seed/system); writeFounderContext is the one place the table is written",
  "src/tools/context.ts": "update_context: upsertFounderContext(…, 'founder') stamps every key it writes",
  "src/gateway/focus-commands.ts": "/focus and /projects: upsertFounderContext(…, 'founder') stamps current_focus / active_projects",
  "scripts/seed-founder-context.ts": "seedFounderContextDefaults stamps filled keys seed (system for the code-owned three) and refreshed keys system",
  "src/infra/daily-budget-alerts.ts":
    "writes budget_alerts_sent only, an internal key that is never rendered: it has no date to show, so no meta is written (asserted below)",
};

const SCANNED_DIRS = ["src", "scripts", "deploy", "drizzle", ".github"];
const SCANNED_EXT = [".ts", ".js", ".mjs", ".sh", ".sql", ".yml", ".yaml"];

/** Calls that write the row, the drizzle table handle imported from the schema, and raw DML against it. */
const WRITE_CALLS = /\b(upsertFounderContext|seedFounderContextDefaults|writeFounderContext)\b/;
const TABLE_HANDLE_IMPORT = /import\s*\{[^}]*\bfounderContext\b[^}]*\}\s*from\s*["'][^"']*schema(\.js)?["']/;
const RAW_DML = /\b(insert\s+into|update|delete\s+from|truncate(\s+table)?)\s+("?agents"?\.)?"?founder_context"?/i;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED_EXT.some((ext) => name.endsWith(ext)) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** TS/JS only: a comment that names a writer (as this file's own header does) is not a writer. */
function withoutComments(path: string, text: string): string {
  if (!/\.(ts|js|mjs)$/.test(path)) return text;
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function writerFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) => walk(join(ROOT, dir)))
    .filter((path) => {
      const text = withoutComments(path, readFileSync(path, "utf8"));
      return WRITE_CALLS.test(text) || TABLE_HANDLE_IMPORT.test(text) || RAW_DML.test(text);
    })
    .map((path) => relative(ROOT, path))
    .sort();
}

describe("founder_context writers — the list is complete", () => {
  it("finds exactly the writers this file knows, so a new one has to be added here (and stamp its keys)", () => {
    const found = writerFiles();
    const unknown = found.filter((f) => !(f in KNOWN_WRITERS));
    expect(
      unknown,
      `New founder_context writer: ${unknown.join(", ")}. Send it through upsertFounderContext(tenant, updates, source) so ` +
        "every key it writes is dated, then add its file to KNOWN_WRITERS with what it stamps.",
    ).toEqual([]);
    const gone = Object.keys(KNOWN_WRITERS).filter((f) => !found.includes(f));
    expect(gone, `KNOWN_WRITERS lists a file that no longer writes the row: ${gone.join(", ")}`).toEqual([]);
  });

  it("gives every writer a stated reason, and only queries.ts touches the table itself", () => {
    for (const [file, why] of Object.entries(KNOWN_WRITERS)) expect(why.length, file).toBeGreaterThan(20);
    const direct = writerFiles().filter((file) => {
      const text = withoutComments(file, readFileSync(join(ROOT, file), "utf8"));
      return TABLE_HANDLE_IMPORT.test(text) || RAW_DML.test(text);
    });
    expect(direct).toEqual(["src/db/queries.ts"]);
  });

  it("would notice a writer it does not know (the scanner itself works)", () => {
    const sample = "await upsertFounderContext(tenant, { notes }, 'founder');";
    expect(WRITE_CALLS.test(sample)).toBe(true);
    expect(WRITE_CALLS.test("// upsertFounderContext is documented here")).toBe(true); // raw text matches …
    expect(WRITE_CALLS.test(withoutComments("x.ts", "// upsertFounderContext is documented here\nconst a = 1;"))).toBe(false); // … comments are stripped first
    expect(RAW_DML.test("UPDATE agents.founder_context SET data = '{}'")).toBe(true);
    expect(RAW_DML.test("SELECT count(*) FROM agents.founder_context")).toBe(false);
    expect(TABLE_HANDLE_IMPORT.test('import { founderContext } from "./schema.js";')).toBe(true);
  });
});

describe("founder_context writers — what each leaves in context_meta", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    store.row = { notes: "old", [CONTEXT_META_KEY]: { notes: { at: JUNE_AT, source: "seed" } } };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const meta = (): Record<string, unknown> => (store.row?.[CONTEXT_META_KEY] ?? {}) as Record<string, unknown>;

  it("update_context (the model, for the founder): dates every key it writes as the founder's", async () => {
    const { updateContext } = await import("../../../src/tools/context.js");
    await updateContext.invoke({ updates: { current_focus: "Close the Acme pilot", active_clients: ["Acme"] } });
    expect(meta()["current_focus"]).toEqual({ at: NOW.toISOString(), source: "founder" });
    expect(meta()["active_clients"]).toEqual({ at: NOW.toISOString(), source: "founder" });
    expect(meta()["notes"]).toEqual({ at: JUNE_AT, source: "seed" });
  });

  it("update_context rejected by the guard: writes nothing, so stamps nothing", async () => {
    const before = structuredClone(store.row);
    const { updateContext } = await import("../../../src/tools/context.js");
    await updateContext.invoke({ updates: { secret_plan: "delete prod" } });
    expect(store.row).toEqual(before);
  });

  it("the budget alert sweep: writes its bookkeeping key and no date", async () => {
    const { recordBudgetAlertSent } = await import("../../../src/infra/daily-budget-alerts.js");
    await recordBudgetAlertSent("turicks", 80);
    expect(store.row?.[BUDGET_ALERTS_KEY]).toBeDefined();
    expect(meta()).toEqual({ notes: { at: JUNE_AT, source: "seed" } });
    expect(Object.keys(meta())).not.toContain(BUDGET_ALERTS_KEY);
  });

  it("the deploy seed: dates what it fills, as seed for a founder fact and system for a code-owned key", async () => {
    const { seedFounderContextDefaults } = await import("../../../src/db/queries.js");
    await seedFounderContextDefaults("turicks", { location: "Amsterdam", tech_stack: "v3 kernel" });
    expect(meta()["location"]).toEqual({ at: NOW.toISOString(), source: "seed" });
    expect(meta()["tech_stack"]).toEqual({ at: NOW.toISOString(), source: "system" });
    expect(meta()["notes"]).toEqual({ at: JUNE_AT, source: "seed" });
  });
});
