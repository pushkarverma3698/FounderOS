/**
 * FounderOS — Provider probe CLI
 * ==============================
 * Run gws + Composio + LinkedIn reachability checks from the shell.
 *
 *   node --env-file=.env --import tsx/esm scripts/probe-providers.ts
 */

import { runProviderProbes } from "../src/infra/provider-probes.js";
import {
  getCalendarBackend,
  getGmailBackend,
  getLinkedInBackend,
} from "../src/infra/provider-config.js";

const tag = (s: string) => (s === "up" ? "✅" : s === "down" ? "❌" : "⚪");

(async () => {
  console.log(`Gmail backend:    ${getGmailBackend()}`);
  console.log(`Calendar backend: ${getCalendarBackend()}`);
  console.log(`LinkedIn backend: ${getLinkedInBackend()}\n`);
  const report = await runProviderProbes();
  console.log(`Checked at: ${report.checked_at}\n`);
  console.log(`${tag(report.gws_gmail.status)} gws Gmail:       ${report.gws_gmail.detail}`);
  console.log(`${tag(report.composio_gmail.status)} Composio Gmail:  ${report.composio_gmail.detail}`);
  console.log(`${tag(report.active_gmail.status)} Active Gmail (${report.gmail_backend}): ${report.active_gmail.detail}`);
  console.log(
    `${tag(report.active_calendar.status)} Active Calendar (${report.calendar_backend}): ${report.active_calendar.detail}`,
  );
  console.log(
    `${tag(report.active_linkedin.status)} Active LinkedIn (${report.linkedin_backend}): ${report.active_linkedin.detail}`,
  );
  process.exit(report.active_gmail.status === "down" ? 1 : 0);
})();
