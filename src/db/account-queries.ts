/**
 * FounderOS — Integration account DB queries
 * ==========================================
 * CRUD for agents.integration_accounts. No raw secrets — credential_refs only.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "./client.js";
import { integrationAccounts, type NewIntegrationAccountRow } from "./schema.js";

export async function getIntegrationAccount(accountKey: string, platform: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.account_key, accountKey),
        eq(integrationAccounts.platform, platform),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listIntegrationAccounts(opts?: { status?: string }) {
  const db = getDb();
  if (opts?.status) {
    return db
      .select()
      .from(integrationAccounts)
      .where(eq(integrationAccounts.status, opts.status));
  }
  return db.select().from(integrationAccounts);
}

export async function upsertIntegrationAccount(
  data: Omit<NewIntegrationAccountRow, "id" | "created_at" | "updated_at">,
): Promise<void> {
  const db = getDb();
  const existing = await getIntegrationAccount(data.account_key, data.platform);
  if (existing) {
    await db
      .update(integrationAccounts)
      .set({
        display_name: data.display_name,
        status: data.status ?? "active",
        auth_backend: data.auth_backend,
        credential_refs: data.credential_refs,
        metadata: data.metadata ?? null,
        updated_at: new Date(),
      })
      .where(eq(integrationAccounts.id, existing.id));
    return;
  }

  await db.insert(integrationAccounts).values(data);
}
