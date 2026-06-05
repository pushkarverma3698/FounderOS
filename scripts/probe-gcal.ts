/**
 * Google Calendar end-to-end probe — bypasses HITL for direct testing.
 * Tests: all-day event, timed event, calendarTool.execute() integration.
 *
 * Usage: npx tsx --env-file=.env scripts/probe-gcal.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Composio } from "@composio/core";

function readKeyFromEnvFile(key: string): string | undefined {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) return trimmed.slice(key.length + 1).trim();
    }
  } catch {}
  return undefined;
}

const apiKey = readKeyFromEnvFile("COMPOSIO_API_KEY") ?? process.env["COMPOSIO_API_KEY"];
if (!apiKey) { console.error("❌ COMPOSIO_API_KEY not found"); process.exit(1); }

const GCAL_CONN_ID = process.env["COMPOSIO_GCAL_CONN_ID"]
  ?? readKeyFromEnvFile("COMPOSIO_GCAL_CONN_ID")
  ?? "ca_wbg4nQjAnw9o";
const GCAL_USER_ID = process.env["COMPOSIO_GCAL_USER_ID"]
  ?? readKeyFromEnvFile("COMPOSIO_GCAL_USER_ID")
  ?? "pg-test-750dbecb-ef9d-4ef7-a76d-d1de1fd0190f";

console.log(`\nUsing connection: ${GCAL_CONN_ID}`);
console.log(`Using user:       ${GCAL_USER_ID}`);

const composio = new Composio({ apiKey });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = composio.getClient() as any;

/**
 * Determine if a Composio result is a real success or a "soft failure"
 * (where the API returns 200 but with an error message in data.message).
 */
function isRealSuccess(result: Record<string, unknown>): { ok: boolean; eventId?: string; link?: string } {
  const outer = result["data"] as Record<string, unknown> | undefined;
  const inner = (outer?.["response_data"] ?? outer) as Record<string, unknown> | undefined;
  // If the response has a "message" string with no id, it's an error message
  if (typeof outer?.["message"] === "string" && !inner?.["id"]) {
    return { ok: false };
  }
  const eventId = inner?.["id"] as string | undefined;
  const link = (outer?.["display_url"] ?? inner?.["htmlLink"]) as string | undefined;
  return { ok: !!eventId, eventId, link };
}

async function createEventRaw(label: string, args: Record<string, unknown>): Promise<boolean> {
  console.log(`\n=== ${label} ===`);
  console.log("Args:", JSON.stringify(args));
  try {
    const result = await client.tools.execute("GOOGLECALENDAR_CREATE_EVENT", {
      connected_account_id: GCAL_CONN_ID,
      user_id: GCAL_USER_ID,
      arguments: args,
    });
    const { ok, eventId, link } = isRealSuccess(result);
    if (ok) {
      console.log(`✅ Created — ID: ${eventId}`);
      if (link) console.log(`   Link: ${link}`);
    } else {
      const msg = (result?.["data"] as any)?.["message"] ?? JSON.stringify(result).slice(0, 300);
      console.error(`❌ API returned error: ${msg}`);
    }
    return ok;
  } catch (err) {
    console.error("❌ FAILED:", (err as Error).message);
    return false;
  }
}

async function main() {
  let passed = 0;
  let failed = 0;

  // ── Test 1: All-day event (original user request: "2nd July, label 'UK'") ──
  const r1 = await createEventRaw("TEST 1 — All-day 'UK' on 2 Jul 2026 (T00:00 – T23:59)", {
    summary: "UK",
    start_datetime: "2026-07-02T00:00:00",
    end_datetime:   "2026-07-02T23:59:00",
    timezone: "Europe/Amsterdam",
  });
  r1 ? passed++ : failed++;

  // ── Test 2: Timed event ───────────────────────────────────────────────────
  const r2 = await createEventRaw("TEST 2 — Timed 09:00-10:00 on 10 Jul 2026", {
    summary: "FounderOS probe test — safe to delete",
    description: "Auto-created by probe-gcal.ts",
    start_datetime: "2026-07-10T09:00:00",
    end_datetime:   "2026-07-10T10:00:00",
    timezone: "Europe/Amsterdam",
  });
  r2 ? passed++ : failed++;

  // ── Test 3: calendarTool.execute() via our wrapper ────────────────────────
  console.log("\n=== TEST 3 — calendarTool.execute() (all-day via wrapper) ===");
  try {
    const { calendarTool } = await import("../src/tools/calendar.js");
    const res = await calendarTool.execute({
      title: "FounderOS smoke test — delete me",
      date: "2026-07-20",   // all-day
      description: "Created by probe-gcal.ts calendarTool test",
    });
    if (res.success && (res.data as any)?.event_id) {
      console.log(`✅ calendarTool.execute() — ID: ${(res.data as any).event_id}`);
      if ((res.data as any).html_link) console.log(`   Link: ${(res.data as any).html_link}`);
      passed++;
    } else if (res.success) {
      // success flag but no event id — possible soft failure
      console.error("❌ calendarTool returned success=true but no event_id:", JSON.stringify(res));
      failed++;
    } else {
      console.error("❌ calendarTool.execute() failed:", res.error);
      failed++;
    }
  } catch (err) {
    console.error("❌ import/execute threw:", (err as Error).message);
    failed++;
  }

  // ── Test 4: calendarTool timed event ─────────────────────────────────────
  console.log("\n=== TEST 4 — calendarTool.execute() (timed event) ===");
  try {
    const { calendarTool } = await import("../src/tools/calendar.js");
    const res = await calendarTool.execute({
      title: "FounderOS timed smoke test — delete me",
      date: "2026-07-20T14:00:00",
      timezone: "Europe/Amsterdam",
    });
    if (res.success && (res.data as any)?.event_id) {
      console.log(`✅ calendarTool timed — ID: ${(res.data as any).event_id}`);
      passed++;
    } else {
      console.error("❌ timed calendarTool failed:", res.error ?? JSON.stringify(res));
      failed++;
    }
  } catch (err) {
    console.error("❌ threw:", (err as Error).message);
    failed++;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed / ${passed + failed} total`);
  if (failed === 0) {
    console.log("✅ All tests passed — Google Calendar integration is fully working!");
    console.log("   Open Google Calendar and verify the test events appeared.");
  } else {
    console.log("❌ Some tests failed — see output above");
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
