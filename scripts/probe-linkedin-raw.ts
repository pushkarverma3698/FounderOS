/**
 * Dump the RAW Composio response for LINKEDIN_CREATE_LINKED_IN_POST so we can see
 * exactly what comes back (the tool's soft-fail guard hides it). CONNECTIONS-only.
 *
 *   node --env-file=.env --import tsx/esm scripts/probe-linkedin-raw.ts
 */
import {
  executeComposioAction,
  getLinkedInConnectionId,
  getLinkedInUserId,
  getLinkedInAuthorUrn,
} from "../src/infra/composio.js";

async function main() {
  const args = {
    author: getLinkedInAuthorUrn(),
    commentary: "🧪 FounderOS QA raw probe (CONNECTIONS) — " + new Date().toISOString(),
    visibility: "CONNECTIONS",
  };
  console.log("author:", args.author, "conn:", getLinkedInConnectionId(), "user:", getLinkedInUserId());
  const res = await executeComposioAction(
    "LINKEDIN_CREATE_LINKED_IN_POST",
    args,
    getLinkedInConnectionId(),
    getLinkedInUserId(),
  );
  console.log("\n=== RAW RESPONSE ===");
  console.log(JSON.stringify(res, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("THROW:", (e as Error).message);
  process.exit(1);
});
