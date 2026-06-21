/**
 * verify-account-registry.ts
 * ==========================
 * Cross-verification: proves department → account_key → credential refs chain
 * without mocks. Run after accounts:seed for DB-backed refs.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/verify-account-registry.ts
 */

import { closeDatabaseConnections } from "../src/db/client.js";
import {
  DEPARTMENT_ACCOUNT_DEFAULTS,
  EMAIL_DEPARTMENTS,
  PLATFORMS,
  resolveAccountKey,
} from "../src/core/accounts.js";
import { resolveAccountContext } from "../src/infra/account-registry.js";
import {
  defaultCredentialRefs,
  resolveGoogleCredentials,
  resolveLinkedInCredentials,
} from "../src/infra/credential-resolver.js";
import type { Platform } from "../src/core/accounts.js";

const CHAIN_CASES: Array<{ department: string; platform: Platform; expect: string }> = [
  { department: "sales", platform: "google", expect: "turicks" },
  { department: "comms", platform: "google", expect: "turicks" },
  { department: "jobhunt", platform: "google", expect: "personal" },
  { department: "marketing", platform: "linkedin", expect: "turicks" },
  { department: "jobhunt", platform: "linkedin", expect: "personal" },
  { department: "marketing", platform: "instagram", expect: "turicks" },
];

async function main(): Promise<void> {
  console.log("🔍 Account registry chain verification\n");
  console.log("Central choke points:");
  console.log("  1. src/core/accounts.ts          — routing table + seed specs");
  console.log("  2. src/infra/account-registry.ts — resolveAccountContext()");
  console.log("  3. src/infra/credential-resolver.ts — secret lookup");
  console.log("  4. src/infra/providers/*         — platform adapters only\n");

  let passed = 0;
  let failed = 0;

  for (const c of CHAIN_CASES) {
    const key = resolveAccountKey(c.platform, { department: c.department });
    const ok = key === c.expect;
    console.log(
      `${ok ? "✅" : "❌"} ${c.department.padEnd(10)} + ${c.platform.padEnd(10)} → ${key} (expected ${c.expect})`,
    );
    if (ok) passed++;
    else failed++;

    const ctx = await resolveAccountContext({ platform: c.platform, department: c.department });
    const routingOk = ctx.account_key === c.expect;
    console.log(
      `   registry: account_key=${ctx.account_key} source=${ctx.source} auth=${ctx.auth_backend}`,
    );

    if (c.platform === "google") {
      const gwsDir = resolveGoogleCredentials(ctx.credential_refs).gws_profile_dir;
      console.log(`   gws profile: ${gwsDir}`);
      const expectDir = `/accounts/${c.expect}/gws`;
      if (!gwsDir.includes(expectDir)) {
        console.log(`   ❌ gws dir mismatch — expected path containing ${expectDir}`);
        failed++;
      }
    }
    if (c.platform === "linkedin") {
      const refs = ctx.credential_refs;
      console.log(
        `   env refs: token=${refs.access_token_env} urn=${refs.author_urn_env}`,
      );
      const creds = resolveLinkedInCredentials(refs);
      console.log(`   resolved: token=${creds.access_token ? "SET" : "MISSING"} urn=${creds.author_urn ?? "MISSING"}`);
    }
    console.log();
  }

  console.log("─".repeat(60));
  console.log(`Routing cases: ${passed}/${CHAIN_CASES.length} passed`);

  console.log("\nDepartment routing table (single file: src/core/accounts.ts):");
  for (const dept of Object.keys(DEPARTMENT_ACCOUNT_DEFAULTS).sort()) {
    const map = DEPARTMENT_ACCOUNT_DEFAULTS[dept]!;
    const parts = Object.entries(map).map(([p, k]) => `${p}→${k}`).join(", ");
    console.log(`  ${dept}: ${parts}`);
  }

  console.log("\nEmail departments (capabilities.ts binds once per dept):");
  console.log(`  ${EMAIL_DEPARTMENTS.join(", ")}`);

  console.log("\nConvention defaults (no DB required):");
  for (const platform of PLATFORMS) {
    const refs = defaultCredentialRefs(platform, "personal", "direct");
    const keys = Object.values(refs).filter(Boolean);
    if (keys.length) console.log(`  personal/${platform}: ${keys.join(", ")}`);
  }

  console.log();
  if (failed > 0) {
    console.error(`❌ ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("✅ All routing chains verified");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => closeDatabaseConnections());
