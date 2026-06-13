/**
 * List all Composio connected accounts and print env var block for .env.production
 * Usage: npx tsx --env-file=.env scripts/list-composio-connections.ts
 */

import { Composio } from "@composio/core";

const API_KEY = process.env["COMPOSIO_API_KEY"];
if (!API_KEY) {
  console.error("COMPOSIO_API_KEY not set — run with: npx tsx --env-file=.env scripts/list-composio-connections.ts");
  process.exit(1);
}

async function listConnections(): Promise<void> {
  const composio = new Composio({ apiKey: API_KEY });
  const client = composio.getClient();

  const res = await client.connectedAccounts.list({});
  // SDK may return { items: [...] } or the array directly
  const connections: Array<Record<string, unknown>> =
    Array.isArray(res) ? res :
    Array.isArray((res as unknown as Record<string, unknown>)["items"]) ? (res as unknown as Record<string, unknown>)["items"] as Array<Record<string, unknown>> :
    [];

  if (connections.length === 0) {
    console.log("No connected accounts found.");
    console.log("Raw response:", JSON.stringify(res, null, 2));
    return;
  }

  console.log(`\nFound ${connections.length} connection(s):\n`);
  console.log("─".repeat(70));

  const appLabel = (c: Record<string, unknown>): string =>
    ((c["appName"] ?? c["appUniqueId"] ?? c["toolkit"] ?? "unknown") as string).toLowerCase();

  // Group by app
  const byApp = new Map<string, Array<Record<string, unknown>>>();
  for (const c of connections) {
    const app = appLabel(c);
    if (!byApp.has(app)) byApp.set(app, []);
    byApp.get(app)!.push(c);
  }

  for (const [app, conns] of byApp) {
    console.log(`\n  App: ${app.toUpperCase()}`);
    for (const c of conns) {
      const id = c["id"] ?? c["connectedAccountId"];
      const entity = c["entityId"] ?? c["userId"] ?? "(none)";
      const status = c["status"] ?? "?";
      console.log(`    id=${id}  entityId=${entity}  status=${status}`);
    }
  }

  console.log("\n" + "─".repeat(70));
  console.log("\n# ── Paste these into .env.production ──\n");

  const emit = (appKey: string, connVar: string, userVar: string): void => {
    const conn = connections.find((c) => appLabel(c).includes(appKey));
    if (conn) {
      const id = conn["id"] ?? conn["connectedAccountId"];
      const entity = conn["entityId"] ?? conn["userId"] ?? "";
      console.log(`${connVar}=${id}`);
      console.log(`${userVar}=${entity}`);
    } else {
      console.log(`# ${connVar}=   ← no ${appKey} connection found`);
      console.log(`# ${userVar}=   ← no ${appKey} connection found`);
    }
    console.log();
  };

  emit("gmail", "COMPOSIO_GMAIL_CONN_ID", "COMPOSIO_GMAIL_USER_ID");
  emit("linkedin", "COMPOSIO_LINKEDIN_CONN_ID", "COMPOSIO_LINKEDIN_USER_ID");
  emit("googlecalendar", "COMPOSIO_GCAL_CONN_ID", "COMPOSIO_GCAL_USER_ID");
  emit("instagram", "COMPOSIO_INSTAGRAM_CONN_ID", "COMPOSIO_INSTAGRAM_USER_ID");
}

listConnections().catch((err: unknown) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
