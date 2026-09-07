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

// ── Credential failures (the only ones worth waking the founder for) ──────────

/**
 * Substrings that mean the GRANT is dead, not the network.
 *
 * Deliberately narrow. A refresh token that has been revoked or has expired
 * cannot self-heal — only the founder can re-authorise it — while a timeout or
 * a 503 will be gone by the next probe. Alerting on the second kind is how an
 * alert channel gets muted, and a muted channel is worse than none.
 */
const CREDENTIAL_FAILURE_MARKERS = [
  "invalid_grant",
  "invalid_client",
  "unauthorized",
  "authentication failed",
  "expired or revoked",
  "401",
  "403",
];

/** True when a probe's `detail` describes a dead credential rather than a blip. */
export function isCredentialFailure(detail: string | undefined): boolean {
  if (!detail) return false;
  const lower = detail.toLowerCase();
  return CREDENTIAL_FAILURE_MARKERS.some((marker) => lower.includes(marker));
}

/** Probe name → what the founder actually lost. `active_gmail` means nothing to him. */
const CAPABILITY_LABEL: Record<string, string> = {
  active_gmail: "Gmail (reading and sending email)",
  active_calendar: "Calendar (reading and creating events)",
  active_linkedin: "LinkedIn (posting and comments)",
};

export interface ProviderAuthFailure {
  readonly provider: string;
  readonly detail: string | undefined;
}

/**
 * One message covering every capability whose credential died, or "" for none.
 *
 * One message, not one per capability: Gmail and Calendar share a grant, so
 * they fail together and always did — production logged the identical
 * `invalid_grant` for both, twice, on 2026-09-04 and 2026-09-06.
 */
export function formatProviderAuthAlert(failures: readonly ProviderAuthFailure[]): string {
  if (failures.length === 0) return "";
  const lost = failures.map((f) => `• ${CAPABILITY_LABEL[f.provider] ?? f.provider}`).join("\n");
  const cause = failures[0]?.detail?.split("\n").pop()?.trim().slice(0, 300) ?? "unknown";
  return (
    `🔑 <b>Google sign-in expired — these stopped working:</b>\n${lost}\n\n` +
    `Everything else is fine; only the connection is. It cannot fix itself — ` +
    `the account has to be re-authorised by you.\n` +
    `<code>${cause.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`
  );
}

export async function runProviderSmokeAtBoot(
  notify: (html: string) => Promise<void> = defaultNotify,
): Promise<void> {
  log.info("Running provider smoke probes…");
  const report = await runProviderProbes();
  const tag = (s: ProviderStatus) => (s === "up" ? "UP" : s === "down" ? "DOWN" : "SKIP");

  log.info(
    `[boot] gmail=${report.gmail_backend}/${tag(report.active_gmail.status)} ` +
      `calendar=${report.calendar_backend}/${tag(report.active_calendar.status)} ` +
      `linkedin=${report.linkedin_backend}/${tag(report.active_linkedin.status)}`,
  );

  const authFailures: ProviderAuthFailure[] = [];
  for (const [name, cap] of [
    ["active_gmail", report.active_gmail],
    ["active_calendar", report.active_calendar],
    ["active_linkedin", report.active_linkedin],
  ] as const) {
    if (cap.status !== "down") continue;
    if (isCredentialFailure(cap.detail)) {
      // error, not warn: a dead grant is a standing outage needing a human,
      // and it stayed invisible for days at warn (issue #426 item 4).
      log.error({ provider: name, detail: cap.detail }, "Active provider DOWN — credential expired or revoked");
      authFailures.push({ provider: name, detail: cap.detail });
    } else {
      log.warn({ provider: name, detail: cap.detail }, "Active provider probe DOWN");
    }
  }

  if (authFailures.length > 0) {
    await notify(formatProviderAuthAlert(authFailures)).catch((err) =>
      // allow-failopen: a Telegram blip must not stop boot; the error line above is already written
      log.warn({ err: (err as Error).message }, "Provider auth alert send failed"),
    );
  }
}

/** Lazy import so provider-probes stays usable in tests without the Telegram stack. */
async function defaultNotify(html: string): Promise<void> {
  const { sendToChat } = await import("./telegram-send.js");
  await sendToChat(html, "HTML");
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
