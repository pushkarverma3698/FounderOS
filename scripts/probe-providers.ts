/**
 * FounderOS — Provider probe CLI
 * ==============================
 * Run Composio + gws Gmail reachability checks from the shell.
 *
 *   node --env-file=.env --import tsx/esm scripts/probe-providers.ts
 */

import { runProviderProbes } from "../src/infra/provider-probes.js";
import { getGmailBackend } from "../src/infra/provider-config.js";

const tag = (s: string) => (s === "up" ? "✅" : s === "down" ? "❌" : "⚪");

(async () => {
  console.log(`Gmail backend (env): ${getGmailBackend()}\n`);
  const report = await runProviderProbes();
  console.log(`Checked at: ${report.checked_at}\n`);
  console.log(`${tag(report.composio_gmail.status)} Composio Gmail: ${report.composio_gmail.detail}`);
  console.log(`${tag(report.gws_gmail.status)} gws Gmail:       ${report.gws_gmail.detail}`);
  console.log(`\n→ Active (${report.gmail_backend}): ${report.active_gmail.detail}`);
  process.exit(report.active_gmail.status === "down" ? 1 : 0);
})();
