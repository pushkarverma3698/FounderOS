/**
 * FounderOS — Composio Helper (new SDK: @composio/core)
 * =======================================================
 * The old composio-core@0.5.39 used deprecated v1/v2 APIs (now 410 Gone).
 * This module uses @composio/core@0.10.0 which targets the v3 API.
 *
 * Shell env poisoning fix:
 *   Node's --env-file flag does NOT override existing shell env vars.
 *   If COMPOSIO_API_KEY is set in the shell (e.g. from a .zshrc or a previous
 *   session), it wins over the value in .env — causing 401s when the shell has
 *   a stale key. This helper reads the key from the .env FILE directly so the
 *   correct key is always used regardless of shell state.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Composio } from "@composio/core";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "composio" });

/** Read a key from the .env file, bypassing shell env var override. */
function readKeyFromEnvFile(key: string): string | undefined {
  try {
    const envPath = resolve(process.cwd(), ".env");
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) {
        return trimmed.slice(key.length + 1).trim();
      }
    }
  } catch {
    // .env file doesn't exist (CI/production) — fall back to process.env
  }
  return undefined;
}

/**
 * Get the Composio API key.
 * Reads from .env FILE first to bypass shell env overrides, then falls
 * back to process.env (works in CI where .env doesn't exist).
 */
export function getComposioApiKey(): string | undefined {
  return readKeyFromEnvFile("COMPOSIO_API_KEY") ?? process.env["COMPOSIO_API_KEY"];
}

/**
 * Execute a Composio action using the @composio/core v0.10.0 SDK (v3 API).
 *
 * The v3 API requires either:
 *   - user_id + connected_account_id: most reliable — picks a specific connection
 *   - user_id alone: picks the first active connection for that user/toolkit
 *
 * @param action              Composio action slug (e.g. "GMAIL_SEND_EMAIL")
 * @param arguments_          Action arguments (tool-specific params)
 * @param connectedAccountId  Specific connected account ID (ca_xxx)
 * @param userId              User/entity ID
 */
export async function executeComposioAction(
  action: string,
  arguments_: Record<string, unknown>,
  connectedAccountId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const apiKey = getComposioApiKey();
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY not configured. Add it to .env.");
  }

  log.debug({ action, connectedAccountId, userId }, "Executing Composio action");

  const composio = new Composio({ apiKey });
  const client = composio.getClient();

  // v3.1 execute API: client.tools.execute(slug, { connected_account_id, user_id, arguments })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (client as any).tools.execute(action, {
    connected_account_id: connectedAccountId,
    user_id: userId,
    arguments: arguments_,
  });

  return result as Record<string, unknown>;
}

// ── Known connection IDs (live-verified 2026-06-11; env-overridable) ──
//
// All three Gmail accounts and the LinkedIn account were confirmed ACTIVE via
// scripts/probe-composio-conns.ts on 2026-06-11. They are connection IDs, NOT
// secrets — useless without COMPOSIO_API_KEY — so they ship as overridable
// defaults (same pattern as the calendar connection below), meaning a fresh
// clone works out of the box. Override any of them in .env to point at a
// different account.
//
// How to find/refresh your connection IDs:
//   node --env-file=.env --import tsx/esm scripts/probe-composio-conns.ts

/** turicks business Gmail (default for comms/sales). */
export const GMAIL_CONN_TURICKS = "ca_DIQDTHjRcI46";
/** personal Gmail. */
export const GMAIL_CONN_PERSONAL = "ca_nlLqda4MBFaA";
/** pushkar Gmail (e.g. job applications). */
export const GMAIL_CONN_PUSHKAR = "ca_ZraIg9B3Q8NE";
/** Shared Composio entity/user id behind all of the above. */
export const COMPOSIO_USER_ID = "pg-test-750dbecb-ef9d-4ef7-a76d-d1de1fd0190f";
/** turicks LinkedIn (ACTIVE 2026-06-11). */
export const LINKEDIN_CONN_TURICKS = "ca_CDaqpUfRJ7vl";
/** LinkedIn entity id. */
export const LINKEDIN_USER_TURICKS = "turicks-internal";

/** Read an env override (env first, then .env file), falling back to a default. */
function envOr(key: string, fallback: string): string {
  return process.env[key] ?? readKeyFromEnvFile(key) ?? fallback;
}

/** Gmail connected account ID. Defaults to the turicks business Gmail; override with COMPOSIO_GMAIL_CONN_ID. */
export function getGmailConnectionId(): string {
  return envOr("COMPOSIO_GMAIL_CONN_ID", GMAIL_CONN_TURICKS);
}

/** Gmail user ID (Composio entity/user identifier). Override with COMPOSIO_GMAIL_USER_ID. */
export function getGmailUserId(): string {
  return envOr("COMPOSIO_GMAIL_USER_ID", COMPOSIO_USER_ID);
}

/** LinkedIn connected account ID. Defaults to the turicks LinkedIn; override with COMPOSIO_LINKEDIN_CONN_ID. */
export function getLinkedInConnectionId(): string {
  return envOr("COMPOSIO_LINKEDIN_CONN_ID", LINKEDIN_CONN_TURICKS);
}

/** LinkedIn user ID. Override with COMPOSIO_LINKEDIN_USER_ID. */
export function getLinkedInUserId(): string {
  return envOr("COMPOSIO_LINKEDIN_USER_ID", LINKEDIN_USER_TURICKS);
}

/** Google Calendar connected account ID. Defaults to the known connection; overridable via COMPOSIO_GCAL_CONN_ID. */
export function getGCalConnectionId(): string {
  return envOr("COMPOSIO_GCAL_CONN_ID", "ca_wbg4nQjAnw9o"); // known active connection
}

/** Google Calendar user ID. Defaults to the shared entity; overridable via COMPOSIO_GCAL_USER_ID. */
export function getGCalUserId(): string {
  return envOr("COMPOSIO_GCAL_USER_ID", COMPOSIO_USER_ID);
}
