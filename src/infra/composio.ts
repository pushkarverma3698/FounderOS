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

// ── Known connection IDs (configured via env vars — see .env.example) ──
//
// How to find your connection IDs:
//   const client = new Composio({ apiKey: COMPOSIO_API_KEY }).getClient();
//   const accounts = await client.connectedAccounts.list({ toolkit: "gmail" });
//   console.log(accounts.items[0].id, accounts.items[0].userId);

function requireEnv(key: string, hint: string): string {
  const val = process.env[key] ?? readKeyFromEnvFile(key);
  if (!val) {
    throw new Error(
      `Missing required env var ${key}. ${hint}\n` +
      `Add it to your .env file — see .env.example for reference.`
    );
  }
  return val;
}

/** Gmail connected account ID for FounderOS. Set COMPOSIO_GMAIL_CONN_ID in .env. */
export function getGmailConnectionId(): string {
  return requireEnv(
    "COMPOSIO_GMAIL_CONN_ID",
    "Get your Gmail connection ID from app.composio.dev → Connections → Gmail → copy the account ID."
  );
}

/** Gmail user ID (Composio entity/user identifier). Set COMPOSIO_GMAIL_USER_ID in .env. */
export function getGmailUserId(): string {
  return requireEnv(
    "COMPOSIO_GMAIL_USER_ID",
    "Get your Gmail user/entity ID from app.composio.dev → Connections → Gmail → copy the entity ID."
  );
}

/** LinkedIn connected account ID. Set COMPOSIO_LINKEDIN_CONN_ID in .env. */
export function getLinkedInConnectionId(): string {
  return requireEnv(
    "COMPOSIO_LINKEDIN_CONN_ID",
    "Get your LinkedIn connection ID from app.composio.dev → Connections → LinkedIn → copy the account ID."
  );
}

/** LinkedIn user ID. Set COMPOSIO_LINKEDIN_USER_ID in .env. */
export function getLinkedInUserId(): string {
  return requireEnv(
    "COMPOSIO_LINKEDIN_USER_ID",
    "Get your LinkedIn user/entity ID from app.composio.dev → Connections → LinkedIn → copy the entity ID."
  );
}

/**
 * Instagram connected account ID. Set COMPOSIO_INSTAGRAM_CONN_ID in .env.
 * Note: Instagram connections expire — reconnect at app.composio.dev if you see auth errors.
 */
export function getInstagramConnectionId(): string {
  return requireEnv(
    "COMPOSIO_INSTAGRAM_CONN_ID",
    "Get your Instagram connection ID from app.composio.dev → Connections → Instagram → copy the account ID."
  );
}

/** Instagram user ID. Set COMPOSIO_INSTAGRAM_USER_ID in .env. */
export function getInstagramUserId(): string {
  return requireEnv(
    "COMPOSIO_INSTAGRAM_USER_ID",
    "Get your Instagram user/entity ID from app.composio.dev → Connections → Instagram → copy the entity ID."
  );
}
