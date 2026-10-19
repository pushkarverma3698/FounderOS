/**
 * FounderOS — resolve an Arbeitnow posting to the employer's own application form.
 *
 * Arbeitnow's API gives only its own job page. That page has no form, and the VPS browser gets a
 * Cloudflare interstitial on it, so a stored Arbeitnow URL can never be prepared or submitted.
 * The page's "Apply" button is `<job url>/apply`, which answers a plain HTTP request with a 302 to
 * the employer's form (Recruitee, Greenhouse, JOIN, a careers site). Measured 2026-10-19: 13/13
 * live postings redirected. One request, redirects not followed; anything else keeps the original.
 *
 * Himalayas and Jobicy are not handled: Himalayas returns 403 to any request from the VPS, and
 * Jobicy's apply button is an in-page form with no outbound link.
 */

const ARBEITNOW_HOST = /^(?:www\.)?arbeitnow\.[a-z.]+$/i;
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

/** The employer's form URL, or `url` unchanged when it is not Arbeitnow or the redirect is missing. */
export async function resolveEmployerApplyUrl(url: string, fetchImpl: FetchLike = fetch): Promise<string> {
  if (!isArbeitnowUrl(url)) return url;
  let response: Response;
  try {
    response = await fetchImpl(`${url.replace(/\/+$/, "")}/apply`, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // allow-failopen: the stored Arbeitnow URL stays usable as a link; the row reads unsupported.
    return url;
  }
  if (response.status < 300 || response.status >= 400) return url;
  const location = response.headers.get("location") ?? "";
  if (!/^https?:\/\//i.test(location) || isArbeitnowUrl(location)) return url;
  return location;
}
