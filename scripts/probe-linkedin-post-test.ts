/**
 * BUG-A live verification: publish ONE clearly-marked CONNECTIONS-only post
 * through the real linkedinPostTool (exercises the author+visibility fix), then
 * print the real Composio post_id. Proves the contract fix end-to-end.
 *
 *   node --env-file=.env --import tsx/esm scripts/probe-linkedin-post-test.ts
 */
import { linkedinPostTool } from "../src/tools/linkedin.js";
import { closeDatabaseConnections } from "../src/db/client.js";

async function main() {
  const stamp = new Date().toISOString();
  const result = await linkedinPostTool.execute({
    text:
      "🧪 Test post from FounderOS QA (CONNECTIONS-only) — verifying the LinkedIn " +
      `posting pipeline after a contract fix. Will be removed. ${stamp}`,
    visibility: "CONNECTIONS",
    idempotency_key: `linkedin_post:turicks:qa_buga_${stamp}`,
    tenant_id: "turicks",
  });

  console.log("\n=== linkedinPostTool result ===");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => closeDatabaseConnections())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("FAILED:", e);
    await closeDatabaseConnections().catch(() => {});
    process.exit(1);
  });
