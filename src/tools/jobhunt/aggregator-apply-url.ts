/**
 * FounderOS — resolve an Arbeitnow posting to the employer's own application form.
 *
 * Arbeitnow's API gives only its own job page. That page has no form, and the VPS browser gets a
 * Cloudflare interstitial on it, so a stored Arbeitnow URL can never be prepared or submitted.
 * The page's "Apply" button is `<job url>/apply`, which answers a plain HTTP request with a 302 to
 * the employer's form (Recruitee, Greenhouse, JOIN, a careers site). Measured 2026-10-19: 13/13
 * live postings redirected. One request, redirects not followed; anything else keeps the original.
 *
 * Arbeitnow answers 403 to Node fetch unless `Accept` is sent (2026-11-23), hence a wildcard `Accept`.
 * Himalayas gets the same attempt, but expect it to fail: 2026-11-23 a laptop got a Cloudflare managed
 * challenge (403, `cf-mitigated: challenge`) on both the job page and `<job>/apply`, with the wildcard
 * `Accept` too, and its API's `applicationLink` is the Himalayas page itself. Jobicy is not attempted: its
 * apply button is an in-page form and neither page nor API carries an employer link. A row still on one of
 * these two hosts has no employer link: `hasNoEmployerLink` names it so the evening digest can drop it.
 */

const ARBEITNOW_HOST = /^(?:www\.)?arbeitnow\.[a-z.]+$/i;
const HIMALAYAS_HOST = /^(?:www\.)?himalayas\.app$/i;
const JOBICY_HOST = /^(?:www\.)?jobicy\.com$/i;
const TIMEOUT_MS = 10_000;
const USER_AGENT = "founderos-aggregator/1.0 (+jobhunt)";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function isArbeitnowUrl(url: string): boolean {
  const host = hostOf(url);
  return host !== null && ARBEITNOW_HOST.test(host);
}

function isHimalayasUrl(url: string): boolean {
  const host = hostOf(url);
  return host !== null && HIMALAYAS_HOST.test(host);
}

/** True for a Himalayas or Jobicy page: the role has no employer form to prepare or open. */
export function hasNoEmployerLink(url: string | null | undefined): boolean {
  const host = url ? hostOf(url) : null;
  return host !== null && (HIMALAYAS_HOST.test(host) || JOBICY_HOST.test(host));
}

/** `<job page>/apply`, keeping the query string (Himalayas rows carry `?utm_source=api`) after the path. */
function applyPath(url: string): string {
  const u = new URL(url);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/apply`;
  return u.toString();
}

/** The employer's form URL, or `url` unchanged when it is not Arbeitnow or the redirect is missing. */
export async function resolveEmployerApplyUrl(url: string, fetchImpl: FetchLike = fetch): Promise<string> {
  if (!isArbeitnowUrl(url) && !isHimalayasUrl(url)) return url;
  let response: Response;
  try {
    response = await fetchImpl(applyPath(url), {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // allow-failopen: the stored Arbeitnow URL stays usable as a link; the row reads unsupported.
    return url;
  }
  if (response.status < 300 || response.status >= 400) return url;
  const location = response.headers.get("location") ?? "";
  if (!/^https?:\/\//i.test(location) || isArbeitnowUrl(location) || isHimalayasUrl(location)) return url;
  return location;
}
