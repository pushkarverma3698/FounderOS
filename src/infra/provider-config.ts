/**
 * FounderOS — Provider backend configuration
 * ===========================================
 * Centralizes which integration adapter is active for Gmail reads (Composio vs
 * gws). Departments and agent-tools stay unchanged — only tool bodies switch.
 *
 * See ADR-028 (Composio vs direct CLIs).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type GmailBackend = "composio" | "gws";

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

/** Active Gmail read backend. Default composio until gws is verified on prod. */
export function getGmailBackend(): GmailBackend {
  const raw = (envOr("GMAIL_BACKEND") ?? "composio").toLowerCase();
  return raw === "gws" ? "gws" : "composio";
}

/** Path to the gws binary (Google Workspace CLI). */
export function getGwsBin(): string {
  return envOr("GWS_BIN") ?? "gws";
}

/**
 * Run reachability probes at boot (Composio + gws when configured).
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
