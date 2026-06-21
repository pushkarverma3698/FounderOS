/**
 * FounderOS — Integration account identities
 * ============================================
 * Stable account keys + department routing. Tools and providers resolve
 * credentials via account_key — never hardcode "turicks" in tool bodies.
 *
 * See ADR-036 (account registry).
 */

/** Brand / identity that owns a set of platform credentials. */
export const ACCOUNT_KEYS = ["turicks", "personal", "naggar"] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];

/** External platforms wired through the provider layer. */
export const PLATFORMS = ["google", "linkedin", "instagram", "facebook", "github"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** How credentials are obtained for a platform account. */
export const AUTH_BACKENDS = ["gws", "direct", "meta_graph", "composio", "pat"] as const;
export type AuthBackend = (typeof AUTH_BACKENDS)[number];

export const ACCOUNT_STATUSES = ["active", "expired", "disabled"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Credential references — secrets live in .env or on-disk gws profiles, not in Postgres.
 * DB stores only refs so rotation = update .env, not a migration.
 */
export interface CredentialRefs {
  /** Env var holding OAuth access token (LinkedIn, Meta). */
  access_token_env?: string;
  /** Env var holding LinkedIn author URN or Meta page id. */
  author_urn_env?: string;
  /** Env var holding refresh token (optional — manual refresh until vault ships). */
  refresh_token_env?: string;
  /** Directory passed as GWS_CONFIG_HOME / GOOGLE_APPLICATION_CREDENTIALS parent. */
  gws_profile_dir?: string;
  /** Composio rollback — env vars for connection + user id. */
  composio_connection_id_env?: string;
  composio_user_id_env?: string;
  /** GitHub PAT env var. */
  github_token_env?: string;
  /** Meta Graph API app id / page id env vars. */
  meta_app_id_env?: string;
  meta_page_id_env?: string;
}

/** One row in agents.integration_accounts (logical shape). */
export interface IntegrationAccount {
  account_key: AccountKey;
  platform: Platform;
  display_name: string;
  status: AccountStatus;
  auth_backend: AuthBackend;
  credential_refs: CredentialRefs;
  metadata?: Record<string, unknown>;
}

/**
 * Deterministic department → default account for outbound actions.
 * Pure function — unit-tested, not prompt-instructed (rule #16).
 */
export const DEPARTMENT_ACCOUNT_DEFAULTS: Readonly<
  Record<string, Partial<Record<Platform, AccountKey>>>
> = {
  sales: { google: "turicks", linkedin: "turicks" },
  marketing: { google: "turicks", linkedin: "turicks", instagram: "turicks", facebook: "turicks" },
  comms: { google: "turicks" },
  jobhunt: { google: "personal", linkedin: "personal" },
  personal: { google: "personal", linkedin: "personal" },
  engineering: { github: "turicks" },
  research: { google: "turicks" },
  admin: { google: "turicks" },
};

/** Global fallback when department has no mapping. */
export const DEFAULT_ACCOUNT_KEY: AccountKey = "turicks";

/** Resolve account_key from department + platform + optional explicit override. */
export function resolveAccountKey(
  platform: Platform,
  opts: { department?: string; account_key?: string },
): AccountKey {
  const explicit = opts.account_key?.trim().toLowerCase();
  if (explicit && isAccountKey(explicit)) {
    return explicit;
  }

  const dept = opts.department?.trim().toLowerCase();
  if (dept && DEPARTMENT_ACCOUNT_DEFAULTS[dept]?.[platform]) {
    return DEPARTMENT_ACCOUNT_DEFAULTS[dept]![platform]!;
  }

  return DEFAULT_ACCOUNT_KEY;
}

export function isAccountKey(value: string): value is AccountKey {
  return (ACCOUNT_KEYS as readonly string[]).includes(value);
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** Env var naming convention for per-account secrets. */
export function defaultEnvKey(
  platform: Platform,
  field: "ACCESS_TOKEN" | "AUTHOR_URN" | "REFRESH_TOKEN" | "GITHUB_TOKEN",
  accountKey: AccountKey,
): string {
  const prefix =
    platform === "google"
      ? "GOOGLE"
      : platform === "github"
        ? "GITHUB"
        : platform.toUpperCase();
  const suffix = accountKey.toUpperCase();
  if (field === "GITHUB_TOKEN") return `GITHUB_TOKEN_${suffix}`;
  return `${prefix}_${field}_${suffix}`;
}

/** Default gws profile directory on the host. */
export function defaultGwsProfileDir(accountKey: AccountKey): string {
  const home = process.env["HOME"] ?? "/home/founderos";
  return `${home}/.founderos/accounts/${accountKey}/gws`;
}

/**
 * Single source of truth for which accounts × platforms exist.
 * Seed script, status CLI, and docs derive from here — do not duplicate elsewhere.
 */
export const ACCOUNT_SEED_SPECS: ReadonlyArray<{
  account_key: AccountKey;
  display_name: string;
  platforms: ReadonlyArray<{
    platform: Platform;
    auth_backend: AuthBackend;
  }>;
}> = [
  {
    account_key: "turicks",
    display_name: "Turicks (business)",
    platforms: [
      { platform: "google", auth_backend: "gws" },
      { platform: "linkedin", auth_backend: "direct" },
      { platform: "instagram", auth_backend: "meta_graph" },
      { platform: "facebook", auth_backend: "meta_graph" },
      { platform: "github", auth_backend: "pat" },
    ],
  },
  {
    account_key: "personal",
    display_name: "Pushkar (personal)",
    platforms: [
      { platform: "google", auth_backend: "gws" },
      { platform: "linkedin", auth_backend: "direct" },
      { platform: "instagram", auth_backend: "meta_graph" },
      { platform: "facebook", auth_backend: "meta_graph" },
      { platform: "github", auth_backend: "pat" },
    ],
  },
  {
    account_key: "naggar",
    display_name: "Naggar Retreat",
    platforms: [
      { platform: "google", auth_backend: "gws" },
      { platform: "instagram", auth_backend: "meta_graph" },
      { platform: "facebook", auth_backend: "meta_graph" },
    ],
  },
];

/** Departments that send email — each maps to createSendEmailTool(dept) in capabilities.ts */
export const EMAIL_DEPARTMENTS = ["comms", "sales", "jobhunt"] as const;
