/**
 * The employer form URL for a posting. Pure and env-free: the Mac worker (scripts/mac-worker.ts) reaches this through
 * form-platform.ts and must not load src/core/config.ts, which needs the server's DATABASE_URL and Telegram token.
 */
import { extractBoardToken } from "./board-token.js";
import { getAdapter } from "./adapters/index.js";

/**
 * Workable's widget API hands postings out as account-less short links and
 * names `<link>/apply` as the form in its own `application_url` field. With no
 * account in the path there is no board token, so `extractBoardToken` cannot
 * see these — which cost every Workable row its form link (2,636 postings in
 * the 2026-09-28 NL sweep).
 */
const WORKABLE_SHORT_LINK = /^https?:\/\/apply\.workable\.com\/j\/[a-z0-9]+(?:\/apply)?\/?$/i;

export function getApplyUrl(url: string, company: string): string | null {
  if (!url) return null;
  if (WORKABLE_SHORT_LINK.test(url)) {
    const trimmed = url.replace(/\/+$/, "");
    return trimmed.endsWith("/apply") ? trimmed : `${trimmed}/apply`;
  }
  const token = extractBoardToken(url);
  if (!token) return null;
  const adapter = getAdapter(token.ats);
  if (!adapter) return null;
  return adapter.applyUrlFor(url, { name: company, ats: token.ats, token: token.token, markets: [] });
}
