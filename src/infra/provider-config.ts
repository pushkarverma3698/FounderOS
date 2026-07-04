/**
 * FounderOS — Provider backend configuration
 * ===========================================
 * Centralizes which integration adapter is active per platform.
 * Departments and agent-tools stay unchanged — only provider adapters switch.
 *
 * Defaults (ADR-029): gws (Google), direct (LinkedIn). Composio = legacy rollback.
 * See docs/decisions/029-direct-platform-integrations.md
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GoogleBackend, LinkedInBackend } from "./providers/types.js";

export type GmailBackend = GoogleBackend;
export type CalendarBackend = GoogleBackend;

export type ProviderStatus = "up" | "down" | "unconfigured";

export interface ProviderCheck {
  status: ProviderStatus;
  detail: string;
}

function readKeyFromEnvFile(key: string): string | undefined {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) {
        return trimmed.slice(key.length + 1).trim();
      }
    }
  } catch {
    // no .env — fall back to process.env
  }
  return undefined;
}

function envOr(key: string): string | undefined {
  return process.env[key] ?? readKeyFromEnvFile(key);
}

function parseGoogleBackend(raw: string | undefined, fallback: GoogleBackend): GoogleBackend {
  const v = (raw ?? fallback).toLowerCase();
  if (v === "googleapis") return "googleapis";
  if (v === "composio") return "composio";
  return "gws";
}

function parseLinkedInBackend(raw: string | undefined): LinkedInBackend {
  const v = (raw ?? "direct").toLowerCase();
  return v === "composio" ? "composio" : "direct";
}

/** Active Gmail backend. Default: gws (direct Google Workspace CLI). */
export function getGmailBackend(): GmailBackend {
  return parseGoogleBackend(envOr("GMAIL_BACKEND"), "gws");
}

/** Active Calendar backend. Default: gws. Falls back to GMAIL_BACKEND when unset. */
export function getCalendarBackend(): CalendarBackend {
  const explicit = envOr("CALENDAR_BACKEND");
  if (explicit) return parseGoogleBackend(explicit, "gws");
  return getGmailBackend();
}

/** Active LinkedIn backend. Default: direct (LinkedIn Posts API). */
export function getLinkedInBackend(): LinkedInBackend {
  return parseLinkedInBackend(envOr("LINKEDIN_BACKEND"));
}

/** Path to the gws binary (Google Workspace CLI). */
export function getGwsBin(): string {
  // Use `||` not `??`: an empty GWS_BIN (e.g. `GWS_BIN=` in a rendered prod .env)
  // must still fall back to "gws". With `??`, an empty string passes through and
  // execFile("") throws "The argument 'file' cannot be empty" — the exact prod
  // failure that took Gmail down on 2026-07-01. Never exec an empty binary path.
  return envOr("GWS_BIN") || "gws";
}

/**
 * Run reachability probes at boot (gws + legacy Composio when configured).
 * Default: on in production, off in dev/test unless forced.
 */
export function shouldRunProviderSmoke(): boolean {
  const override = envOr("PROVIDER_SMOKE_AT_BOOT");
  if (override === "true") return true;
  if (override === "false") return false;
  return process.env["NODE_ENV"] === "production";
}

/** Timeout for provider probe subprocess / API calls (ms). */
export function getProviderProbeTimeoutMs(): number {
  const raw = envOr("PROVIDER_PROBE_TIMEOUT_MS");
  const n = raw ? parseInt(raw, 10) : 8_000;
  return Number.isFinite(n) && n > 0 ? n : 8_000;
}
