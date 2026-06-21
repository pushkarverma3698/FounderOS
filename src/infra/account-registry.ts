/**
 * FounderOS — Account registry
 * ==============================
 * Resolves account_key → credential refs (DB or convention defaults).
 * Providers call this — tools pass department + optional account_key.
 *
 * See ADR-036.
 */

import type { AccountKey, AuthBackend, CredentialRefs, Platform } from "../core/accounts.js";
import {
  isAccountKey,
  isPlatform,
  resolveAccountKey,
} from "../core/accounts.js";
import { getIntegrationAccount } from "../db/account-queries.js";
import { defaultCredentialRefs } from "./credential-resolver.js";
import {
  resolveComposioConnection,
  resolveGitHubCredentials,
  resolveGoogleCredentials,
  resolveLinkedInCredentials,
  resolveMetaCredentials,
} from "./credential-resolver.js";

export interface AccountContext {
  account_key: AccountKey;
  platform: Platform;
  auth_backend: AuthBackend;
  credential_refs: CredentialRefs;
  display_name: string;
  status: string;
  source: "db" | "default";
}

export interface ResolveAccountInput {
  platform: Platform;
  department?: string;
  account_key?: string;
}

/** In-memory cache for boot — invalidated on seed. TTL-free; registry rows rarely change. */
const cache = new Map<string, AccountContext>();

function cacheKey(accountKey: string, platform: string): string {
  return `${accountKey}:${platform}`;
}

export function clearAccountRegistryCache(): void {
  cache.clear();
}

/**
 * Resolve full account context for a platform call.
 * Order: explicit account_key → department default → turicks.
 * Credential refs: DB row if present, else convention-based defaults.
 */
export async function resolveAccountContext(input: ResolveAccountInput): Promise<AccountContext> {
  const accountKey = resolveAccountKey(input.platform, {
    department: input.department,
    account_key: input.account_key,
  });

  const hit = cache.get(cacheKey(accountKey, input.platform));
  if (hit) return hit;

  const row = await getIntegrationAccount(accountKey, input.platform);

  let ctx: AccountContext;
  if (row && row.status !== "disabled") {
    const refs = (row.credential_refs ?? {}) as CredentialRefs;
    ctx = {
      account_key: accountKey,
      platform: input.platform,
      auth_backend: row.auth_backend as AuthBackend,
      credential_refs: refs,
      display_name: row.display_name,
      status: row.status,
      source: "db",
    };
  } else {
    const authBackend = defaultAuthBackend(input.platform);
    ctx = {
      account_key: accountKey,
      platform: input.platform,
      auth_backend: authBackend,
      credential_refs: defaultCredentialRefs(input.platform, accountKey, authBackend),
      display_name: `${accountKey} ${input.platform}`,
      status: "active",
      source: "default",
    };
  }

  cache.set(cacheKey(accountKey, input.platform), ctx);
  return ctx;
}

function defaultAuthBackend(platform: Platform): AuthBackend {
  switch (platform) {
    case "google":
      return "gws";
    case "linkedin":
      return "direct";
    case "instagram":
    case "facebook":
      return "meta_graph";
    case "github":
      return "pat";
    default:
      return "direct";
  }
}

/** Google/gws credentials for an account. */
export async function getGoogleAccount(input: ResolveAccountInput) {
  const ctx = await resolveAccountContext({ ...input, platform: "google" });
  return { ctx, credentials: resolveGoogleCredentials(ctx.credential_refs) };
}

/** LinkedIn credentials for an account. */
export async function getLinkedInAccount(input: ResolveAccountInput) {
  const ctx = await resolveAccountContext({ ...input, platform: "linkedin" });
  return { ctx, credentials: resolveLinkedInCredentials(ctx.credential_refs) };
}

/** GitHub PAT for an account. */
export async function getGitHubAccount(input: ResolveAccountInput) {
  const ctx = await resolveAccountContext({ ...input, platform: "github" });
  return { ctx, credentials: resolveGitHubCredentials(ctx.credential_refs) };
}

/** Meta (Instagram/Facebook) credentials — for future marketing tools. */
export async function getMetaAccount(platform: "instagram" | "facebook", input: ResolveAccountInput) {
  const ctx = await resolveAccountContext({ ...input, platform });
  return { ctx, credentials: resolveMetaCredentials(ctx.credential_refs) };
}

/** Composio connection ids for rollback path. */
export async function getComposioAccount(platform: Platform, input: ResolveAccountInput) {
  const ctx = await resolveAccountContext({ ...input, platform });
  return { ctx, connection: resolveComposioConnection(ctx.credential_refs) };
}

export function parseAccountKey(value: unknown): AccountKey | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return isAccountKey(v) ? v : undefined;
}

export function parsePlatform(value: unknown): Platform | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return isPlatform(v) ? v : undefined;
}
