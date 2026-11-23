/**
 * Apply queue: the Mini App page shell
 * ====================================
 * `GET /apply/queue` serves a shell with no personal data (Telegram's initData lives in the URL fragment, so the
 * server cannot render per user). Its one inline script (apply-queue-script.ts) asks `GET /apply/api/queue` with the
 * X-Telegram-Init-Data header and draws the four groups. Same shell, style hash and CSP as the answer and
 * hand-off pages (apply-page.ts), so no new policy.
 */

import { readApplyLinkConfig } from "../tools/jobhunt/apply-link.js";
import { escapeHtml, shell } from "./apply-page.js";
import { APPLY_QUEUE_SCRIPT } from "./apply-queue-script.js";

const TELEGRAM_SCRIPT = "https://telegram.org/js/telegram-web-app.js";

/** The public address of the queue page, or null while the apply link config is incomplete. */
export function applyQueueUrl(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const cfg = readApplyLinkConfig(env);
  return cfg.ok ? `${cfg.baseUrl}/apply/queue` : null;
}

export function renderQueueShell(nonce: string): string {
  const n = escapeHtml(nonce);
  const body =
    `<h1>Your apply queue</h1><p class="sub" id="aq-sub">Today's roles, grouped by what each one needs from you.</p>` +
    `<p class="note" id="aq-status" role="status">Loading your queue.</p><div id="aq-body"></div>`;
  const scripts = `<script nonce="${n}" src="${TELEGRAM_SCRIPT}"></script><script nonce="${n}">${APPLY_QUEUE_SCRIPT}</script>`;
  return shell("Apply queue", body, "", scripts);
}
