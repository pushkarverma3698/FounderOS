/**
 * FounderOS — Integration provider health probes
 * ================================================
 * Reachability checks for gws (primary) and legacy Composio — used at boot smoke,
 * /health, and /status. Failures name the REAL component (rule #22).
 */

import { Composio } from "@composio/core";
import { getComposioApiKey, getGmailConnectionId, getLinkedInConnectionId } from "./composio.js";
import { runGws } from "./gws-runner.js";
import {
  getCalendarBackend,
  getGmailBackend,
  getLinkedInBackend,
  getProviderProbeTimeoutMs,
  type ProviderCheck,
  type ProviderStatus,
} from "./provider-config.js";
import { linkedInDirectConfigured } from "./providers/linkedin-direct.js";
import { composioGoogleConfigured } from "./providers/google-composio.js";
import { composioLinkedInConfigured } from "./providers/linkedin-composio.js";
import { directReadEmails, googleapisConfigured } from "./providers/google-direct.js";
import type { GoogleBackend } from "./providers/types.js";
import type { ToolResult } from "../tools/index.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "provider-probes" });

export interface ProviderProbeReport {
  checked_at: string;
  gmail_backend: GoogleBackend;
  calendar_backend: GoogleBackend;
  linkedin_backend: "direct" | "composio";
  gws_gmail: ProviderCheck;
  googleapis_gmail: ProviderCheck;
  composio_gmail: ProviderCheck;
  active_gmail: ProviderCheck;
  active_calendar: ProviderCheck;
  active_linkedin: ProviderCheck;
}

let lastProbe: ProviderProbeReport | null = null;

export function getLastProviderProbe(): ProviderProbeReport | null {
  return lastProbe;
}

export function setLastProviderProbe(report: ProviderProbeReport): void {
  lastProbe = report;
}

function check(status: ProviderStatus, detail: string): ProviderCheck {
  return { status, detail };
}

/**
 * Fetch a Composio connected account and map its live status to a ProviderCheck.
 * Resources live on the Composio INSTANCE in the installed SDK (@composio/core
 * ≥0.10) — getClient() exposes a different generated client without this
 * surface, which crashed every probe in prod on 2026-07-12.
 */
async function probeComposioConnection(
  label: string,
  connId: string,
  timeoutMs: number,
): Promise<ProviderCheck> {
  try {
    const composio = new Composio({ apiKey: getComposioApiKey()!, allowTracking: false });
    const probe = composio.connectedAccounts.get(connId);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} probe timed out`)), timeoutMs),
    );
    const account = (await Promise.race([probe, timeout])) as unknown as Record<string, unknown>;
    const status = String(account["status"] ?? account["state"] ?? "unknown");
    if (status.toUpperCase() === "ACTIVE") {
      return check("up", `${label} ${connId} ACTIVE`);
    }
    return check("down", `${label} ${connId} status=${status}`);
  } catch (err) {
    return check("down", `${label} probe failed: ${(err as Error).message}`);
  }
}

/** Probe Composio: API key present + Gmail connection ACTIVE. */
export async function probeComposioGmail(timeoutMs = getProviderProbeTimeoutMs()): Promise<ProviderCheck> {
  if (!composioGoogleConfigured()) {
    return check("unconfigured", "COMPOSIO_API_KEY not set (legacy fallback)");
  }
  return probeComposioConnection("Composio Gmail", getGmailConnectionId(), timeoutMs);
}

/** Probe gws: binary exists + auth/list smoke (maxResults 1). */
export async function probeGwsGmail(timeoutMs = getProviderProbeTimeoutMs()): Promise<ProviderCheck> {
  const auth = await runGws(["auth", "status"], Math.min(timeoutMs, 5_000));
  // "not installed" is gws-runner's ENOENT mapping (missing binary / empty GWS_BIN)
  // — an unconfigured host, not a failing provider.
  if (!auth.ok && (auth.error.includes("not found") || auth.error.includes("not installed"))) {
    return check("unconfigured", auth.error);
  }

  const listed = await runGws(
    ["gmail", "users", "messages", "list", "--params", JSON.stringify({ userId: "me", maxResults: 1 })],
    timeoutMs,
  );
  if (listed.ok) {
    return check("up", "gws gmail.users.messages.list OK");
  }
  if (auth.ok) {
    return check("down", `gws authenticated but Gmail list failed: ${listed.error}`);
  }
  return check("down", `gws not ready: ${listed.error}`);
}

/** Probe googleapis: service-account + subject configured, then a 1-message list. */
export async function probeGoogleapisGmail(
  timeoutMs = getProviderProbeTimeoutMs(),
): Promise<ProviderCheck> {
  if (!(await googleapisConfigured())) {
    return check("unconfigured", "GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_SUBJECT_* not set");
  }
  try {
    const probe = directReadEmails({ query: "", max_results: 1 });
    const timeout = new Promise<ToolResult>((_, reject) =>
      setTimeout(() => reject(new Error("googleapis probe timed out")), timeoutMs),
    );
    const result = await Promise.race([probe, timeout]);
    return result.success
      ? check("up", "googleapis Gmail list OK")
      : check("down", `googleapis Gmail probe failed: ${result.error}`);
  } catch (err) {
    return check("down", `googleapis Gmail probe failed: ${(err as Error).message}`);
  }
}

function probeLinkedInDirect(): ProviderCheck {
  if (!linkedInDirectConfigured()) {
    return check("unconfigured", "LINKEDIN_ACCESS_TOKEN or LINKEDIN_AUTHOR_URN not set");
  }
  return check("up", "LinkedIn direct API credentials configured");
}

/**
 * Probe Composio LinkedIn: API key present + the connection is ACTUALLY ACTIVE
 * (reachability, not just presence) — mirrors probeComposioGmail.
 *
 * Fix (2026-07-01): this used to return "up" whenever COMPOSIO_API_KEY was
 * merely present, without ever calling the Composio API to check the LinkedIn
 * connection's real status. That is exactly the shallow check that let the
 * documented Composio outage (LIMITATIONS.md §7 — "Composio key was invalid in
 * both dev and prod: email/linkedin/calendar down") go undetected: /status's
 * 🟢/🔴 LinkedIn indicator would have shown a false 🟢 the whole time.
 */
export async function probeLinkedInComposio(
  timeoutMs = getProviderProbeTimeoutMs(),
): Promise<ProviderCheck> {
  if (!composioLinkedInConfigured()) {
    return check("unconfigured", "COMPOSIO_API_KEY not set (legacy fallback)");
  }
  return probeComposioConnection("Composio LinkedIn", getLinkedInConnectionId(), timeoutMs);
}

/** Run all provider probes and cache the result. */
export async function runProviderProbes(): Promise<ProviderProbeReport> {
  const timeoutMs = getProviderProbeTimeoutMs();
  const gmailBackend = getGmailBackend();
  const calendarBackend = getCalendarBackend();
  const linkedinBackend = getLinkedInBackend();

  const [composio_gmail, gws_gmail, googleapis_gmail] = await Promise.all([
    probeComposioGmail(timeoutMs),
    probeGwsGmail(timeoutMs),
    probeGoogleapisGmail(timeoutMs),
  ]);

  const pick = (b: GoogleBackend): ProviderCheck =>
    b === "gws" ? gws_gmail : b === "googleapis" ? googleapis_gmail : composio_gmail;
  const active_gmail = pick(gmailBackend);
  const active_calendar = pick(calendarBackend);
  const active_linkedin =
    linkedinBackend === "direct" ? probeLinkedInDirect() : await probeLinkedInComposio(timeoutMs);

  const report: ProviderProbeReport = {
    checked_at: new Date().toISOString(),
    gmail_backend: gmailBackend,
    calendar_backend: calendarBackend,
    linkedin_backend: linkedinBackend,
    composio_gmail,
    gws_gmail,
    googleapis_gmail,
    active_gmail,
    active_calendar,
    active_linkedin,
  };
  setLastProviderProbe(report);
  return report;
}

export async function runProviderSmokeAtBoot(): Promise<void> {
  log.info("Running provider smoke probes…");
  const report = await runProviderProbes();
  const tag = (s: ProviderStatus) => (s === "up" ? "UP" : s === "down" ? "DOWN" : "SKIP");

  log.info(
    `[boot] gmail=${report.gmail_backend}/${tag(report.active_gmail.status)} ` +
      `calendar=${report.calendar_backend}/${tag(report.active_calendar.status)} ` +
      `linkedin=${report.linkedin_backend}/${tag(report.active_linkedin.status)}`,
  );

  for (const [name, cap] of [
    ["active_gmail", report.active_gmail],
    ["active_calendar", report.active_calendar],
    ["active_linkedin", report.active_linkedin],
  ] as const) {
    if (cap.status === "down") {
      log.warn({ provider: name, detail: cap.detail }, "Active provider probe DOWN");
    }
  }
}

export function formatProviderStatusLine(report: ProviderProbeReport | null): string {
  const gmail = getGmailBackend();
  const linkedin = getLinkedInBackend();
  if (!report) {
    return `📡 Gmail: <code>${gmail}</code> · LinkedIn: <code>${linkedin}</code> (probe pending)`;
  }
  const icon = (s: ProviderStatus) => (s === "up" ? "🟢" : s === "down" ? "🔴" : "⚪");
  return (
    `${icon(report.active_gmail.status)} Gmail <code>${gmail}</code> · ` +
    `${icon(report.active_linkedin.status)} LinkedIn <code>${linkedin}</code>`
  );
}
