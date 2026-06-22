/**
 * seed-integration-accounts.ts
 * ============================
 * Upserts integration_accounts rows (metadata + credential refs only — no secrets).
 * Secrets stay in .env and gws profile dirs per ACCOUNT-REGISTRY-RUNBOOK.md.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/seed-integration-accounts.ts
 */

import { closeDatabaseConnections } from "../src/db/client.js";
import { upsertIntegrationAccount } from "../src/db/account-queries.js";
import { clearAccountRegistryCache } from "../src/infra/account-registry.js";
import { defaultCredentialRefs } from "../src/infra/credential-resolver.js";
import { ACCOUNT_SEED_SPECS, defaultGwsProfileDir } from "../src/core/accounts.js";

async function main(): Promise<void> {
  console.log("🔐 Seeding integration_accounts (credential refs only)…\n");

  for (const acct of ACCOUNT_SEED_SPECS) {
    for (const { platform, auth_backend } of acct.platforms) {
      const credential_refs = defaultCredentialRefs(platform, acct.account_key, auth_backend);
      if (platform === "google") {
        credential_refs.gws_profile_dir = defaultGwsProfileDir(acct.account_key);
      }

      await upsertIntegrationAccount({
        account_key: acct.account_key,
        platform,
        display_name: `${acct.display_name} — ${platform}`,
        status: "active",
        auth_backend,
        credential_refs,
        metadata: { seeded_by: "scripts/seed-integration-accounts.ts" },
      });

      console.log(`  ✅ ${acct.account_key}/${platform} (${auth_backend})`);
    }
  }

  clearAccountRegistryCache();
  console.log("\n🎉 Done. Next: follow docs/guides/ACCOUNT-REGISTRY-RUNBOOK.md to auth each profile.\n");
}

main()
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  })
  .finally(() => closeDatabaseConnections());
