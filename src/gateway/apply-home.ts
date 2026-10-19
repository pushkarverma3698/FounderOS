/**
 * Apply home: the Mini App job list shell
 * =======================================
 * `GET /apply/home` serves a static shell. Telegram puts initData in the URL fragment, which never reaches the
 * server, so the page cannot be rendered per user here: its one inline script (apply-home-script.ts) calls
 * `GET /apply/api/jobs` with the X-Telegram-Init-Data header and the server answers with JSON for that
 * profile only (apply-prepare-api.ts). No user data is in this HTML, and the script writes server text with
 * textContent only.
 *
 * Same CSP style as the answer page: a pinned style hash, a per-request script nonce, Telegram's WebApp script,
 * fetch to the page's own origin and nothing else.
 */

import { createHash } from "node:crypto";
import { readApplyLinkConfig } from "../tools/jobhunt/apply-link.js";
import { APPLY_HOME_SCRIPT } from "./apply-home-script.js";

const CSS =
  "body{margin:0;background:#f6f7f9;color:#14181f;font:16px/1.45 system-ui,-apple-system,sans-serif}" +
  "main{max-width:640px;margin:0 auto;padding:16px}h1{font-size:1.25rem;margin:0 0 4px}" +
  ".sub{color:#5b6573;margin:0 0 12px}ul{list-style:none;padding:0;margin:0}" +
  "li button{display:block;width:100%;text-align:left;font:inherit;padding:12px;margin:0 0 8px;border:1px solid #dde1e7;border-radius:10px;background:#fff;color:inherit}" +
  "li button:disabled{opacity:.6}.co{font-weight:600}.st{display:block;color:#5b6573;font-size:.85rem}" +
  "#msg{color:#5b6573;margin:8px 0}" +
  "@media(prefers-color-scheme:dark){body{background:#0f1319;color:#e6e9ee}li button{background:#171c24;border-color:#2a313c}.sub,.st,#msg{color:#9aa4b2}}";

const STYLE_HASH = createHash("sha256").update(CSS).digest("base64");
const TELEGRAM_SCRIPT_HOST = "https://telegram.org";

/** The public address of the home page, or null while the apply link config is incomplete. */
export function applyHomeUrl(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const cfg = readApplyLinkConfig(env);
  return cfg.ok ? `${cfg.baseUrl}/apply/home` : null;
}

export function homePageHeaders(nonce: string): Readonly<Record<string, string>> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; script-src 'nonce-${nonce}' ${TELEGRAM_SCRIPT_HOST}; connect-src 'self'; ` +
      `form-action 'none'; frame-ancestors https://web.telegram.org; base-uri 'none'`,
  };
}

export function renderHomePage(nonce: string): string {
  const meta = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">`;
  const body =
    `<main><h1>Jobs to apply to</h1><p class="sub">Tap a job. The bot fills its form, then you review and submit.</p>` +
    `<p id="msg" role="status">Loading…</p><ul id="jobs"></ul></main>` +
    `<script nonce="${nonce}" src="${TELEGRAM_SCRIPT_HOST}/js/telegram-web-app.js"></script><script nonce="${nonce}">${APPLY_HOME_SCRIPT}</script>`;
  return `<!doctype html><html lang="en"><head>${meta}<title>Jobs</title><style>${CSS}</style></head><body>${body}</body></html>`;
}
