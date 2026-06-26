/**
 * FounderOS — Credential resolver
 * =================================
 * Reads secrets from .env (bypassing shell override) using CredentialRefs from
 * the account registry. Secrets never stored in Postgres.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AccountKey, CredentialRefs, Platform } from "../core/accounts.js";
import {
  defaultEnvKey,
  defaultGwsProfileDir,
} from "../core/accounts.js";

/** Read a key from the .env file, bypassing shell env overrides (composio pattern). */
export function readEnvValue(key: string): string | undefined {
  const fromProcess = process.env[key];
  try {
    const content = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) {
        const fromFile = trimmed.slice(key.length + 1).trim();
        return fromFile || fromProcess;
      }
    }
  } catch {
    // no .env — use process.env
  }
  return fromProcess;
}

export interface ResolvedGoogleCredentials {
  gws_profile_dir: string;
  /** Path to the service-account JSON (googleapis backend). */
  service_account_path?: string;
  /** Mailbox to impersonate via domain-wide delegation (googleapis backend). */
  impersonate_subject?: string;
}

export interface ResolvedLinkedInCredentials {
  access_token?: string;
  author_urn?: string;
}

export interface ResolvedGitHubCredentials {
  token?: string;
}

export interface ResolvedMetaCredentials {
  access_token?: string;
  page_id?: string;
  app_id?: string;
}

/** Build default credential refs when no DB row exists (convention-over-config). */
export function defaultCredentialRefs(
  platform: Platform,
  accountKey: AccountKey,
  authBackend: "gws" | "direct" | "meta_graph" | "composio" | "pat",
): CredentialRefs {
  switch (platform) {
    case "google":
      return {
        gws_profile_dir: defaultGwsProfileDir(accountKey),
        // googleapis backend: one shared service-account JSON across the Workspace
        // (domain-wide delegation), with a per-account impersonation subject.
        google_sa_path_env: "GOOGLE_APPLICATION_CREDENTIALS",
        google_subject_env: `GOOGLE_SUBJECT_${accountKey.toUpperCase()}`,
        composio_connection_id_env:
          accountKey === "turicks" ? "COMPOSIO_GMAIL_CONN_ID" : `COMPOSIO_GMAIL_CONN_ID_${accountKey.toUpperCase()}`,
        composio_user_id_env:
          accountKey === "turicks" ? "COMPOSIO_GMAIL_USER_ID" : `COMPOSIO_GMAIL_USER_ID_${accountKey.toUpperCase()}`,
      };
    case "linkedin":
      return {
        access_token_env:
          accountKey === "turicks" ? "LINKEDIN_ACCESS_TOKEN" : defaultEnvKey("linkedin", "ACCESS_TOKEN", accountKey),
        author_urn_env:
          accountKey === "turicks" ? "LINKEDIN_AUTHOR_URN" : defaultEnvKey("linkedin", "AUTHOR_URN", accountKey),
        composio_connection_id_env:
          accountKey === "turicks"
            ? "COMPOSIO_LINKEDIN_CONN_ID"
            : `COMPOSIO_LINKEDIN_CONN_ID_${accountKey.toUpperCase()}`,
        composio_user_id_env:
          accountKey === "turicks"
            ? "COMPOSIO_LINKEDIN_USER_ID"
            : `COMPOSIO_LINKEDIN_USER_ID_${accountKey.toUpperCase()}`,
      };
    case "instagram":
    case "facebook":
      return {
        access_token_env: defaultEnvKey(platform, "ACCESS_TOKEN", accountKey),
        meta_page_id_env: `META_${platform.toUpperCase()}_PAGE_ID_${accountKey.toUpperCase()}`,
        meta_app_id_env: `META_APP_ID_${accountKey.toUpperCase()}`,
      };
    case "github":
      return {
        github_token_env:
          accountKey === "turicks" ? "GITHUB_TOKEN" : defaultEnvKey("github", "GITHUB_TOKEN", accountKey),
      };
    default:
      return {};
  }
}

export function resolveGoogleCredentials(refs: CredentialRefs): ResolvedGoogleCredentials {
  const saPathKey = refs.google_sa_path_env ?? "GOOGLE_APPLICATION_CREDENTIALS";
  const subjectKey = refs.google_subject_env;
  const subject =
    (subjectKey ? readEnvValue(subjectKey) : undefined) ?? readEnvValue("GOOGLE_IMPERSONATE_SUBJECT");
  return {
    gws_profile_dir: refs.gws_profile_dir ?? defaultGwsProfileDir("turicks"),
    service_account_path: readEnvValue(saPathKey),
    impersonate_subject: subject,
  };
}

export function resolveLinkedInCredentials(refs: CredentialRefs): ResolvedLinkedInCredentials {
  const accessKey = refs.access_token_env ?? "LINKEDIN_ACCESS_TOKEN";
  const urnKey = refs.author_urn_env ?? "LINKEDIN_AUTHOR_URN";
  return {
    access_token: readEnvValue(accessKey),
    author_urn: readEnvValue(urnKey),
  };
}

export function resolveGitHubCredentials(refs: CredentialRefs): ResolvedGitHubCredentials {
  const key = refs.github_token_env ?? "GITHUB_TOKEN";
  return { token: readEnvValue(key) };
}

export function resolveMetaCredentials(refs: CredentialRefs): ResolvedMetaCredentials {
  const tokenKey = refs.access_token_env;
  const pageKey = refs.meta_page_id_env;
  const appKey = refs.meta_app_id_env;
  return {
    access_token: tokenKey ? readEnvValue(tokenKey) : undefined,
    page_id: pageKey ? readEnvValue(pageKey) : undefined,
    app_id: appKey ? readEnvValue(appKey) : undefined,
  };
}

export function resolveComposioConnection(refs: CredentialRefs): {
  connection_id?: string;
  user_id?: string;
} {
  const connKey = refs.composio_connection_id_env;
  const userKey = refs.composio_user_id_env;
  return {
    connection_id: connKey ? readEnvValue(connKey) : undefined,
    user_id: userKey ? readEnvValue(userKey) : undefined,
  };
}
