/**
 * accounts-status.ts — list integration accounts + env credential presence
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/accounts-status.ts
 */

import { closeDatabaseConnections } from "../src/db/client.js";
import { listIntegrationAccounts } from "../src/db/account-queries.js";
import { readEnvValue } from "../src/infra/credential-resolver.js";
import type { CredentialRefs } from "../src/core/accounts.js";

function checkRefs(refs: CredentialRefs): string[] {
  const missing: string[] = [];
  if (refs.access_token_env && !readEnvValue(refs.access_token_env)) {
    missing.push(refs.access_token_env);
  }
  if (refs.author_urn_env && !readEnvValue(refs.author_urn_env)) {
    missing.push(refs.author_urn_env);
  }
  if (refs.github_token_env && !readEnvValue(refs.github_token_env)) {
    missing.push(refs.github_token_env);
  }
  if (refs.composio_connection_id_env && !readEnvValue(refs.composio_connection_id_env)) {
    missing.push(refs.composio_connection_id_env);
  }
  return missing;
}

async function main(): Promise<void> {
  const rows = await listIntegrationAccounts();
  if (rows.length === 0) {
    console.log("No integration_accounts rows. Run: pnpm accounts:seed\n");
    return;
  }

  console.log(`\nIntegration accounts (${rows.length} rows)\n${"─".repeat(72)}`);

  for (const row of rows.sort((a, b) =>
    a.account_key.localeCompare(b.account_key) || a.platform.localeCompare(b.platform),
  )) {
    const refs = (row.credential_refs ?? {}) as CredentialRefs;
    const missing = checkRefs(refs);
    const icon = row.status === "active" && missing.length === 0 ? "🟢" : missing.length ? "🔴" : "🟡";
    console.log(
      `${icon} ${row.account_key.padEnd(10)} ${row.platform.padEnd(10)} ${row.auth_backend.padEnd(10)} ${row.display_name}`,
    );
    if (refs.gws_profile_dir) console.log(`     gws profile: ${refs.gws_profile_dir}`);
    if (missing.length) console.log(`     missing env: ${missing.join(", ")}`);
  }

  console.log(`${"─".repeat(72)}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => closeDatabaseConnections());
