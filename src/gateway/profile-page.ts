/**
 * Saved-answers editor: the static shell page
 * ===========================================
 * GET /apply/profile carries no data and no secret: Telegram puts initData in the URL fragment, which never
 * reaches the server, so the one inline script (profile-page-script.ts) reads it and loads the answers from
 * GET /apply/api/profile. Same CSP approach as the apply answer page: default-src 'none', one pinned style
 * hash, a per-request script nonce plus Telegram's WebApp script, connect-src 'self'. No unsafe-inline script.
 */

import { createHash } from "node:crypto";
import { escapeHtml } from "./apply-page.js";
import { PROFILE_PAGE_SCRIPT } from "./profile-page-script.js";

const CSS =
  "body{margin:0;background:#f6f7f9;color:#14181f;font:16px/1.45 system-ui,-apple-system,sans-serif}" +
  "main{max-width:640px;margin:0 auto;padding:16px}h1{font-size:1.25rem;margin:0 0 4px}" +
  "h2{font-size:1.05rem;margin:24px 0 8px}.sub{color:#5b6573;margin:0 0 12px}" +
  ".card{background:#fff;border:1px solid #dde1e7;border-radius:10px;padding:12px;margin:0 0 12px}" +
  ".card .t{display:block;font-weight:600;margin-bottom:6px;overflow-wrap:anywhere}" +
  "input,select,textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #b9c0cb;border-radius:8px;background:#fff;color:inherit}" +
  "textarea{min-height:5rem}.row{display:flex;gap:8px;margin-top:8px}" +
  "button{flex:1;font:inherit;font-weight:600;padding:12px;border:0;border-radius:10px;background:#1f6feb;color:#fff}" +
  "button.alt{background:transparent;color:inherit;border:1px solid #b9c0cb}button.danger{background:#b42318}button:disabled{opacity:.5}" +
  ".err{color:#b42318;font-size:.9rem;margin:6px 0 0;overflow-wrap:anywhere}.hint{color:#5b6573;font-size:.85rem;margin:6px 0 0}" +
  "#msg{position:sticky;top:0;z-index:1;border-radius:10px;padding:10px;margin:0 0 12px;overflow-wrap:anywhere}" +
  "#msg.ok{background:#e6f4ea;border:1px solid #8fc9a0;color:#14532d}#msg.bad{background:#fdecea;border:1px solid #f0a8a0;color:#7a1a12}" +
  "ul.facts{padding-left:20px;margin:0}ul.facts li{margin:2px 0;overflow-wrap:anywhere}" +
  "@media(prefers-color-scheme:dark){body{background:#0f1319;color:#e6e9ee}.card{background:#171c24;border-color:#2a313c}" +
  "input,select,textarea{background:#0f1319;border-color:#3a4350}.sub,.hint{color:#9aa4b2}" +
  "#msg.ok{background:#12301d;border-color:#2f6b45;color:#bfe8cb}#msg.bad{background:#34130f;border-color:#7a2b22;color:#f5c2bc}}";

const STYLE_HASH = createHash("sha256").update(CSS).digest("base64");
const TELEGRAM_SCRIPT_HOST = "https://telegram.org";

/** Response headers with the CSP for one request's nonce. Only Telegram Web may frame the page. */
export function profileHeaders(nonce: string): Readonly<Record<string, string>> {
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

/** The shell. The nonce is the one the headers were built with. */
export function renderProfilePage(nonce: string): string {
  const n = escapeHtml(nonce);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">` +
    `<title>Saved answers</title><style>${CSS}</style></head><body><main>` +
    `<h1>Saved answers</h1><p class="sub" id="who">Loading</p><div id="msg" role="status" hidden></div><div id="root"></div>` +
    `</main><script nonce="${n}" src="${TELEGRAM_SCRIPT_HOST}/js/telegram-web-app.js"></script>` +
    `<script nonce="${n}">${PROFILE_PAGE_SCRIPT}</script></body></html>`
  );
}
