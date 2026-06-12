/**
 * Resolve the LinkedIn author URN (required by LINKEDIN_CREATE_LINKED_IN_POST)
 * and inspect the post action's input schema. Read-only — publishes nothing.
 *
 *   node --env-file=.env --import tsx/esm scripts/probe-linkedin-author.ts
 */
import { Composio } from "@composio/core";
import {
  getComposioApiKey,
  getLinkedInConnectionId,
  getLinkedInUserId,
} from "../src/infra/composio.js";

async function main() {
  const apiKey = getComposioApiKey();
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not set");

  const composio = new Composio({ apiKey });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = composio.getClient() as any;

  const conn = getLinkedInConnectionId();
  const user = getLinkedInUserId();
  console.log("conn:", conn, "user:", user);

  // 1) Try to read my LinkedIn person info (gives the author URN).
  for (const slug of ["LINKEDIN_GET_MY_INFO", "LINKEDIN_GET_COMPANY_INFO"]) {
    try {
      const r = await client.tools.execute(slug, {
        connected_account_id: conn,
        user_id: user,
        arguments: {},
      });
      console.log(`\n=== ${slug} ===`);
      console.log(JSON.stringify(r, null, 2).slice(0, 2000));
    } catch (e) {
      console.log(`\n${slug} ERROR:`, (e as Error).message.slice(0, 300));
    }
  }

  // 2) Inspect the create-post action's input schema.
  try {
    const tool = await client.tools.get(user, "LINKEDIN_CREATE_LINKED_IN_POST");
    console.log("\n=== LINKEDIN_CREATE_LINKED_IN_POST schema ===");
    console.log(JSON.stringify(tool, null, 2).slice(0, 3000));
  } catch (e) {
    console.log("\nschema ERROR:", (e as Error).message.slice(0, 300));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
