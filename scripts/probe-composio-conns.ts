/**
 * FounderOS — Composio Connection Inspector (read-only)
 * ======================================================
 * Lists every connected account on the Composio account and prints
 * id → toolkit → user/entity → status. NO secrets printed. Used to map the
 * founder-supplied connection IDs (personal / turicks / pushkar) to the
 * correct toolkit (Gmail / Calendar / LinkedIn / …) before wiring them.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/probe-composio-conns.ts
 */

import { Composio } from "@composio/core";
import { getComposioApiKey } from "../src/infra/composio.js";

const TARGET_IDS: Record<string, string> = {
  personal: "ca_nlLqda4MBFaA",
  turicks: "ca_DIQDTHjRcI46",
  pushkar: "ca_ZraIg9B3Q8NE",
};

function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object") {
      const slug = (v as Record<string, unknown>)["slug"] ?? (v as Record<string, unknown>)["name"];
      if (typeof slug === "string" && slug) return slug;
    }
  }
  return "—";
}

(async () => {
  const apiKey = getComposioApiKey();
  if (!apiKey) {
    console.error("FAIL: COMPOSIO_API_KEY not found in .env");
    process.exit(1);
  }
  const composio = new Composio({ apiKey });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = composio.getClient() as any;

  console.log("Listing all connected accounts…\n");
  let items: Array<Record<string, unknown>> = [];
  try {
    const res = await client.connectedAccounts.list({});
    items = (res?.items ?? res?.data ?? res ?? []) as Array<Record<string, unknown>>;
  } catch (err) {
    console.error("list() failed:", err instanceof Error ? err.message : err);
  }

  if (!Array.isArray(items) || items.length === 0) {
    console.log("(list returned nothing — trying per-id get())\n");
  } else {
    console.log(`Found ${items.length} connected account(s):\n`);
    for (const a of items) {
      const id = pick(a, ["id"]);
      const toolkit = pick(a, ["toolkit", "appName", "app", "integration", "authConfig"]);
      const user = pick(a, ["userId", "user_id", "entityId", "entity_id"]);
      const status = pick(a, ["status", "state"]);
      console.log(`  ${id}  toolkit=${toolkit}  user=${user}  status=${status}`);
    }
    console.log();
  }

  console.log("── Founder-supplied IDs ──");
  for (const [label, id] of Object.entries(TARGET_IDS)) {
    const match = items.find((a) => pick(a, ["id"]) === id);
    if (match) {
      console.log(
        `  ${label.padEnd(8)} ${id}  →  toolkit=${pick(match, ["toolkit", "appName", "app", "integration", "authConfig"])}  user=${pick(match, ["userId", "user_id", "entityId", "entity_id"])}  status=${pick(match, ["status", "state"])}`,
      );
    } else {
      // Fall back to a direct get if list didn't include it.
      try {
        const one = (await client.connectedAccounts.get(id)) as Record<string, unknown>;
        console.log(
          `  ${label.padEnd(8)} ${id}  →  toolkit=${pick(one, ["toolkit", "appName", "app", "integration", "authConfig"])}  user=${pick(one, ["userId", "user_id", "entityId", "entity_id"])}  status=${pick(one, ["status", "state"])}  (via get)`,
        );
      } catch (err) {
        console.log(`  ${label.padEnd(8)} ${id}  →  NOT FOUND (${err instanceof Error ? err.message : err})`);
      }
    }
  }
  console.log();
  process.exit(0);
})();
