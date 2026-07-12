/**
 * FounderOS — pg pool first-query race (pg@9 deprecation warning at boot)
 * ========================================================================
 * Regression test for the production journal warning:
 *   "(node) DeprecationWarning: Calling client.query() when the client is
 *    already executing a query is deprecated and will be removed in pg@9.0."
 *
 * Root cause: getPgPool() registered a pool 'connect' handler that issued a
 * fire-and-forget `client.query("SET search_path …")`. pg-pool emits 'connect'
 * from inside the client's connection callback — BEFORE pg sets
 * readyForQuery — so the SET sits in the client's internal query queue while
 * the pool synchronously hands the same client to the waiting pool.query()
 * caller. That caller's query() sees a non-empty queue and trips pg's
 * deprecation notice on the FIRST query of every fresh connection (at boot:
 * the health probe's SELECT 1).
 *
 * The fix sets search_path via the `options` startup parameter instead
 * (identical to the postgres.js client in the same file) — no query, no race.
 * This test proves both halves: no deprecation warning on a cold pool's first
 * query, AND search_path still resolves to agents, brain, public.
 *
 * Skips cleanly when Postgres is unreachable (keyless CI-without-services).
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import pg from "pg";

// ── Postgres reachability probe (collection-time skip, like the other suites) ──

async function postgresReachable(): Promise<boolean> {
  const url = process.env["DATABASE_URL"];
  if (!url) return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const pgUp = await postgresReachable();
if (!pgUp) {
  // eslint-disable-next-line no-console
  console.warn("[pg-pool-search-path] SKIP — Postgres unreachable at DATABASE_URL");
}

describe.runIf(pgUp)("getPgPool first query on a fresh connection", () => {
  const warnings: string[] = [];
  const onWarning = (w: Error): void => {
    warnings.push(w.message);
  };

  afterAll(async () => {
    process.removeListener("warning", onWarning);
    const { closeDatabaseConnections } = await import("../../src/db/client.js");
    await closeDatabaseConnections();
  });

  it("does not trip pg's queued-query deprecation and still resolves the agents/brain search_path", async () => {
    process.on("warning", onWarning);

    // Cold pool: reset the module registry so the db/client singleton is
    // provably fresh (not merely fresh-by-default per-file isolation). The
    // very first pool.query() then forces a brand-new connection — exactly
    // the code path that raced at boot.
    vi.resetModules();
    const { getPgPool } = await import("../../src/db/client.js");
    const res = await getPgPool().query<{ search_path: string }>("SHOW search_path");

    // process.emitWarning delivers asynchronously — flush before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    const raceWarnings = warnings.filter((m) => m.includes("already executing a query"));
    expect(raceWarnings).toEqual([]);

    // The search_path the 'connect' hook used to provide must survive the fix.
    expect(res.rows[0]?.search_path).toContain("agents");
    expect(res.rows[0]?.search_path).toContain("brain");
    expect(res.rows[0]?.search_path).toContain("public");
  });
});
