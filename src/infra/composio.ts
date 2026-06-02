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

// ── Known connection IDs (read from env or use defaults found via connectedAccounts.list) ──

/** Gmail connected account ID for FounderOS. Read from env or use the primary known ID. */
export function getGmailConnectionId(): string {
  return process.env["COMPOSIO_GMAIL_CONN_ID"] ??
    readKeyFromEnvFile("COMPOSIO_GMAIL_CONN_ID") ??
    "ca_nlLqda4MBFaA";  // primary Gmail connection (pushkarai3698@gmail.com)
}

/** Gmail user ID (Composio entity/user identifier). */
export function getGmailUserId(): string {
  return process.env["COMPOSIO_GMAIL_USER_ID"] ??
    readKeyFromEnvFile("COMPOSIO_GMAIL_USER_ID") ??
    "pg-test-750dbecb-ef9d-4ef7-a76d-d1de1fd0190f";
}

/** LinkedIn connected account ID. */
export function getLinkedInConnectionId(): string {
  return process.env["COMPOSIO_LINKEDIN_CONN_ID"] ??
    readKeyFromEnvFile("COMPOSIO_LINKEDIN_CONN_ID") ??
    "ca_CDaqpUfRJ7vl";  // turicks-internal LinkedIn (ACTIVE)
}

/** LinkedIn user ID. */
export function getLinkedInUserId(): string {
  return process.env["COMPOSIO_LINKEDIN_USER_ID"] ??
    readKeyFromEnvFile("COMPOSIO_LINKEDIN_USER_ID") ??
    "turicks-internal";
}

/**
 * Instagram connected account ID.
 * Current status: ca_Uolj7XmgVl0L is EXPIRED — reconnect at app.composio.dev
 * After reconnect: update COMPOSIO_INSTAGRAM_CONN_ID in .env or hardcode new ID here.
 */
export function getInstagramConnectionId(): string {
  return process.env["COMPOSIO_INSTAGRAM_CONN_ID"] ??
    readKeyFromEnvFile("COMPOSIO_INSTAGRAM_CONN_ID") ??
    "ca_Uolj7XmgVl0L";  // EXPIRED — reconnect in Composio dashboard
}

/** Instagram user ID. */
export function getInstagramUserId(): string {
  return process.env["COMPOSIO_INSTAGRAM_USER_ID"] ??
    readKeyFromEnvFile("COMPOSIO_INSTAGRAM_USER_ID") ??
    "turicks-internal";
}
