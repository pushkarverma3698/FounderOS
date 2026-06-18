#!/usr/bin/env node
/** Verify founder_context contains Phase D-Bis strategy keys (not stale v1 data). */
import { getFounderContext } from "../src/db/queries.js";

const REQUIRED = /Autonomous Studio|\$8K|8K minimum|dev-tool|showcase|proof\.turicks/i;

async function main(): Promise<void> {
  const ctx = await getFounderContext("turicks");
  const json = JSON.stringify(ctx ?? {});
  if (!REQUIRED.test(json)) {
    console.error("Stale founder_context — missing Phase D-Bis keys");
    console.error("Preview:", json.slice(0, 400));
    process.exit(1);
  }
  console.log("✅ founder_context has Phase D-Bis strategy keys");
  process.exit(0);
}

main().catch((err) => {
  console.error("founder context probe fatal:", err);
  process.exit(1);
});
