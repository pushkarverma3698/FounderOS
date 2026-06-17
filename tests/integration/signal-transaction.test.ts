/**
 * P4 — transactional signal publish + audit (real Postgres).
 * Proves partial failure rolls back BOTH dept_signals and action_log rows.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TENANT } from "../../src/core/config.js";
import {
  publishDeptEventWithAudit,
  countDeptSignals,
  writeAuditEntry,
} from "../../src/db/queries.js";
import { getDb } from "../../src/db/client.js";
import { actionLog, deptSignals } from "../../src/db/schema.js";
import { and, eq, sql } from "drizzle-orm";

const signalRow = {
  tenant_id: TENANT,
  from_dept: "research",
  to_dept: "sales",
  event_type: "lead_discovered",
  payload: { company: "P4 Tx Test", icpScore: 85, source: "integration" },
  consumed: false,
};

describe("P4 publishDeptEventWithAudit (real Postgres)", () => {
  const idemKey = `p4-tx-test-${Date.now()}`;

  beforeEach(async () => {
    const db = getDb();
    await db.delete(actionLog).where(eq(actionLog.idempotency_key, idemKey));
    await db
      .delete(deptSignals)
      .where(
        and(
          eq(deptSignals.tenant_id, TENANT),
          sql`${deptSignals.payload}->>'company' = 'P4 Tx Test'`,
        ),
      );
  });

  it("commits signal + audit atomically on success", async () => {
    const countBefore = await countDeptSignals(TENANT);
    const { signalId } = await publishDeptEventWithAudit(signalRow, {
      tenant_id: TENANT,
      action: "signal_published",
      idempotency_key: idemKey,
      payload: { event_type: "lead_discovered", signalId: "placeholder" },
    });
    expect(signalId).toBeTruthy();
    expect(await countDeptSignals(TENANT)).toBe(countBefore + 1);

    const db = getDb();
    const [audit] = await db
      .select()
      .from(actionLog)
      .where(eq(actionLog.idempotency_key, idemKey))
      .limit(1);
    expect(audit?.action).toBe("signal_published");
  });

  it("rolls back signal when audit insert fails (duplicate idempotency_key)", async () => {
    await writeAuditEntry({
      tenant_id: TENANT,
      action: "signal_published",
      idempotency_key: idemKey,
      payload: { preexisting: true },
    });

    const countBefore = await countDeptSignals(TENANT);

    await expect(
      publishDeptEventWithAudit(signalRow, {
        tenant_id: TENANT,
        action: "signal_published",
        idempotency_key: idemKey,
        payload: { event_type: "lead_discovered" },
      }),
    ).rejects.toThrow();

    expect(await countDeptSignals(TENANT)).toBe(countBefore);
  });
});
