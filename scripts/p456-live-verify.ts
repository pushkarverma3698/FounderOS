/**
 * P4/P5/P6 live verification — transactional signal + schema row counts + hierarchy trace.
 */
import { createHash } from "node:crypto";
import { TENANT } from "../src/core/config.js";
import {
  publishDeptEventWithAudit,
  countDeptSignals,
  getRecentAuditEntries,
} from "../src/db/queries.js";
import { getPgPool, closeDatabaseConnections } from "../src/db/client.js";
import { TraceCallback } from "../src/infra/trace-callback.js";
import { startTurn, hierarchyDepth } from "../src/infra/trace.js";

async function main() {
  // P4 live: transactional publish
  const idem = `p456-live-${Date.now()}`;
  const countBefore = await countDeptSignals(TENANT);
  const { signalId } = await publishDeptEventWithAudit(
    {
      tenant_id: TENANT,
      from_dept: "research",
      to_dept: "sales",
      event_type: "lead_discovered",
      payload: { company: "P456 Live Co", icpScore: 90, source: "live-gate" },
      consumed: false,
    },
    {
      tenant_id: TENANT,
      action: "signal_published",
      idempotency_key: idem,
      payload: { live: true },
    },
  );
  console.log(`PASS p4_live_publish: signalId=${signalId}`);
  if ((await countDeptSignals(TENANT)) !== countBefore + 1) {
    throw new Error("P4 live: signal count did not increment");
  }
  const audits = await getRecentAuditEntries(TENANT, 5);
  if (!audits.some((a) => a.idempotency_key === idem)) {
    throw new Error("P4 live: audit row missing");
  }

  // P5 live: schema table counts
  const pool = getPgPool();
  const agentsCount = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='agents' AND table_type='BASE TABLE'`,
  );
  const brainCount = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='brain' AND table_type='BASE TABLE'`,
  );
  console.log(
    `PASS p5_live_schemas: agents_tables=${agentsCount.rows[0]?.n} brain_tables=${brainCount.rows[0]?.n}`,
  );
  if ((agentsCount.rows[0]?.n ?? 0) < 5 || (brainCount.rows[0]?.n ?? 0) < 1) {
    throw new Error("P5 live: expected tables in agents and brain schemas");
  }

  // P6 live: hierarchy trace golden path
  const trace = startTurn({ chatId: 99, kind: "message", promptHash: createHash("sha256").update("x").digest("hex").slice(0, 12) });
  const cb = new TraceCallback(trace);
    await cb.handleChainStart({ id: ["supervisor"] } as never, {}, "a", undefined, [], {}, "supervisor");
    await cb.handleChainStart({ id: ["engineering"] } as never, {}, "b", "a", [], {}, "engineering");
    await cb.handleChainStart({ id: ["devops"] } as never, {}, "c", "b", [], {}, "devops");
  const depths = trace.events
    .filter((e) => e.seam === "hierarchy.enter")
    .map((e) => e.data?.["depth"]);
  if (JSON.stringify(depths) !== JSON.stringify([0, 1, 2])) {
    throw new Error(`P6 live: expected depths [0,1,2] got ${JSON.stringify(depths)}`);
  }
  console.log(`PASS p6_live_trace: turnId=${trace.turnId} depths=${JSON.stringify(depths)}`);
  console.log(`       grep turnId in logs: ${trace.turnId}`);

  // Sanity: hierarchyDepth pure function
  if (hierarchyDepth("engineering") !== 1) throw new Error("hierarchyDepth broken");

  console.log("\nP4/P5/P6 live verification passed.");
  await closeDatabaseConnections();
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
