/**
 * FounderOS — Integration account DB queries
 * ==========================================
 * CRUD for agents.integration_accounts. No raw secrets — credential_refs only.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "./client.js";
import { integrationAccounts } from "./schema.js";

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
