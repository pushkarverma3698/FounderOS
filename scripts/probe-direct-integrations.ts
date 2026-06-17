/**
 * FounderOS — Direct integration probe CLI
 * =========================================
 * Verifies gws (Google) + LinkedIn direct API reachability before prod cutover.
 *
 *   node --env-file=.env --import tsx/esm scripts/probe-direct-integrations.ts
 */

import { runProviderProbes } from "../src/infra/provider-probes.js";
import {
  getCalendarBackend,
  getGmailBackend,
  getLinkedInBackend,
} from "../src/infra/provider-config.js";

const tag = (s: string) => (s === "up" ? "✅" : s === "down" ? "❌" : "⚪");

(async () => {
  console.log("FounderOS — Direct integration probe (ADR-029)\n");
  console.log(`Gmail backend:    ${getGmailBackend()}`);
  console.log(`Calendar backend: ${getCalendarBackend()}`);
  console.log(`LinkedIn backend: ${getLinkedInBackend()}\n`);

  const report = await runProviderProbes();
  console.log(`Checked at: ${report.checked_at}\n`);

  console.log("── Google Workspace (gws) ──");
  console.log(`${tag(report.gws_gmail.status)} gws Gmail: ${report.gws_gmail.detail}`);

  console.log("\n── Legacy Composio (rollback) ──");
  console.log(`${tag(report.composio_gmail.status)} Composio Gmail: ${report.composio_gmail.detail}`);

  console.log("\n── Active backends ──");
  console.log(`${tag(report.active_gmail.status)} Gmail (${report.gmail_backend}): ${report.active_gmail.detail}`);
  console.log(
    `${tag(report.active_calendar.status)} Calendar (${report.calendar_backend}): ${report.active_calendar.detail}`,
  );
  console.log(
    `${tag(report.active_linkedin.status)} LinkedIn (${report.linkedin_backend}): ${report.active_linkedin.detail}`,
  );

  const failed =
    report.active_gmail.status === "down" ||
    report.active_calendar.status === "down" ||
    report.active_linkedin.status === "down";

  if (failed) {
    console.log("\n❌ One or more active providers are DOWN. Fix before prod cutover.");
    console.log("   Google:  npm install -g @googleworkspace/cli && gws auth login");
    console.log("   LinkedIn: set LINKEDIN_ACCESS_TOKEN + LINKEDIN_AUTHOR_URN in .env");
    console.log("   Rollback: GMAIL_BACKEND=composio LINKEDIN_BACKEND=composio + COMPOSIO_API_KEY");
    process.exit(1);
  }

  if (
    report.active_gmail.status === "unconfigured" ||
    report.active_linkedin.status === "unconfigured"
  ) {
    console.log("\n⚪ Active providers not fully configured — expected until you complete manual setup.");
    process.exit(0);
  }

  console.log("\n✅ All active providers configured and reachable.");
  process.exit(0);
})();
