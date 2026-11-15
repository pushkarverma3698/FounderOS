/**
 * FounderOS — LinkedIn via direct Posts API
 * ===========================================
 * Primary LinkedIn backend. Auth: founder OAuth token in env (admin-owned).
 * No third-party middleman. Post-only scope (ADR-009).
 */

import { readEnvValue } from "../credential-resolver.js";


// YYYYMM version header. 202506 (Marketing June 2025) was SUNSET — keep this on a
// currently-supported month or every call 400s. Override with LINKEDIN_API_VERSION.
export const LINKEDIN_DEFAULT_API_VERSION = "202606";

/** Whether direct LinkedIn API credentials are configured (default/turicks account). */
export function linkedInDirectConfigured(): boolean {
  const token = readEnvValue("LINKEDIN_ACCESS_TOKEN");
  const urn = readEnvValue("LINKEDIN_AUTHOR_URN");
  return !!token && !!urn;
}

export function getLinkedInApiVersion(): string {
  // The env pin may only move the version FORWARD. A stale pin from an old
  // PROD_DOTENV snapshot (202405, live 2026-07-12) silently downgraded below
  // the shipped default and 426'd every LinkedIn call — the code default is
  // the floor.
  const pinned = readEnvValue("LINKEDIN_API_VERSION");
  if (pinned && /^\d{6}$/.test(pinned) && Number(pinned) > Number(LINKEDIN_DEFAULT_API_VERSION)) {
    return pinned;
  }
  return LINKEDIN_DEFAULT_API_VERSION;
}

