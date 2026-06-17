/**
 * FounderOS — Integration provider health probes
 * ================================================
 * Reachability checks for Composio Gmail and gws — used at boot smoke, /health,
 * and /status. Failures are reported with the REAL component name (rule #22).
 */

import { Composio } from "@composio/core";
import {
  getComposioApiKey,
  getGmailConnectionId,
} from "./composio.js";
import { runGws } from "./gws-runner.js";
import {
  getGmailBackend,
  getProviderProbeTimeoutMs,
  type ProviderCheck,
  type ProviderStatus,
} from "./provider-config.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "provider-probes" });

export interface ProviderProbeReport {
  checked_at: string;
  gmail_backend: "composio" | "gws";
  composio_gmail: ProviderCheck;
  gws_gmail: ProviderCheck;
  active_gmail: ProviderCheck;
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

/** Probe Composio: API key present + Gmail connection ACTIVE. */
export async function probeComposioGmail(timeoutMs = getProviderProbeTimeoutMs()): Promise<ProviderCheck> {
  const apiKey = getComposioApiKey();
  if (!apiKey) {
    return check("unconfigured", "COMPOSIO_API_KEY not set");
  }

  const connId = getGmailConnectionId();
  try {
    const composio = new Composio({ apiKey });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = composio.getClient() as any;
    const probe = client.connectedAccounts.get(connId);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Composio probe timed out")), timeoutMs),
    );
    const account = (await Promise.race([probe, timeout])) as Record<string, unknown>;
    const status = String(account["status"] ?? account["state"] ?? "unknown");
    if (status.toUpperCase() === "ACTIVE") {
      return check("up", `Gmail connection ${connId} ACTIVE`);
    }
    return check("down", `Composio Gmail connection ${connId} status=${status} — reconnect at app.composio.dev`);
  } catch (err) {
    const msg = (err as Error).message;
    return check("down", `Composio Gmail probe failed: ${msg}`);
  }
}

/** Probe gws: binary exists + auth/list smoke (maxResults 1). */
export async function probeGwsGmail(timeoutMs = getProviderProbeTimeoutMs()): Promise<ProviderCheck> {
  const auth = await runGws(["auth", "status"], Math.min(timeoutMs, 5_000));
  if (!auth.ok && auth.error.includes("not found")) {
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

/** Run all Gmail provider probes and cache the result. */
export async function runProviderProbes(): Promise<ProviderProbeReport> {
  const timeoutMs = getProviderProbeTimeoutMs();
  const backend = getGmailBackend();
  const [composio_gmail, gws_gmail] = await Promise.all([
    probeComposioGmail(timeoutMs),
    probeGwsGmail(timeoutMs),
  ]);

  const active_gmail = backend === "gws" ? gws_gmail : composio_gmail;

  const report: ProviderProbeReport = {
    checked_at: new Date().toISOString(),
    gmail_backend: backend,
    composio_gmail,
    gws_gmail,
    active_gmail,
  };
  setLastProviderProbe(report);
  return report;
}

/**
 * Boot-time smoke: log provider reachability. Non-fatal — warns only.
 * Called from index.ts when shouldRunProviderSmoke() is true.
 */
export async function runProviderSmokeAtBoot(): Promise<void> {
  log.info("Running provider smoke probes…");
  const report = await runProviderProbes();
  const tag = (s: ProviderStatus) => (s === "up" ? "UP" : s === "down" ? "DOWN" : "SKIP");

  log.info(
    `[boot] Gmail backend=${report.gmail_backend}  active=${tag(report.active_gmail.status)}  composio=${tag(report.composio_gmail.status)}  gws=${tag(report.gws_gmail.status)}`,
  );
  if (report.active_gmail.status === "down") {
    log.warn(
      { detail: report.active_gmail.detail, backend: report.gmail_backend },
      "Active Gmail provider is DOWN — email read/send may fail until fixed",
    );
  }
  for (const [name, cap] of [
    ["composio_gmail", report.composio_gmail],
    ["gws_gmail", report.gws_gmail],
  ] as const) {
    if (cap.status === "down") {
      log.warn({ provider: name, detail: cap.detail }, "Provider probe DOWN");
    }
  }
}

/** One-line summary for /status (uses cache if fresh enough, else config-only). */
export function formatProviderStatusLine(report: ProviderProbeReport | null): string {
  const backend = getGmailBackend();
  if (!report) {
    return `📡 Gmail: <code>${backend}</code> (probe pending)`;
  }
  const icon = report.active_gmail.status === "up" ? "🟢" : report.active_gmail.status === "down" ? "🔴" : "⚪";
  return `${icon} Gmail: <code>${backend}</code> · ${report.active_gmail.detail.slice(0, 60)}`;
}
