/**
 * REGRESSION (H2) — research-tool egress guard.
 * ================================================
 * `scrape_url`/`crawl_site`/`deep_research` fetch model-chosen URLs with no
 * HITL gate (by design — reads aren't gated). A prompt-injected email/web
 * page can steer the model to fetch an attacker URL. A domain allowlist isn't
 * viable (legitimate research hits unpredictable public sites), so this guards
 * the narrower, real risk: SSRF-style internal targets and exfiltration-shaped
 * query strings.
 */
import { describe, it, expect } from "vitest";
import { resolveEgressUrl } from "../../../src/infra/egress-guard.js";

describe("resolveEgressUrl — legitimate public research URLs", () => {
  it("allows an ordinary company site", () => {
    expect(resolveEgressUrl("https://acme.com/pricing").ok).toBe(true);
  });

  it("allows a normal, short query string", () => {
    expect(resolveEgressUrl("https://example.com/search?q=founder+os").ok).toBe(true);
  });

  it("allows http (not just https)", () => {
    expect(resolveEgressUrl("http://example.com").ok).toBe(true);
  });
});

describe("resolveEgressUrl — SSRF / internal targets denied", () => {
  const targets = [
    "http://127.0.0.1/admin",
    "http://localhost:8080/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://10.0.0.5/internal",
    "http://192.168.1.1/router",
    "http://172.16.0.1/",
    "http://[::1]/",
  ];
  for (const url of targets) {
    it(`denies ${url}`, () => {
      const r = resolveEgressUrl(url);
      expect(r.ok).toBe(false);
    });
  }

  it("does not false-positive on a public IP that merely starts with 172 but isn't in the private range", () => {
    // 172.32.x.x is OUTSIDE the 172.16.0.0/12 private range (172.16–172.31).
    expect(resolveEgressUrl("http://172.32.0.1/").ok).toBe(true);
  });
});

describe("resolveEgressUrl — exfiltration-shaped query strings denied", () => {
  it("denies an oversized query string (data-payload shape)", () => {
    const payload = "x".repeat(600);
    const r = resolveEgressUrl(`https://evil.tld/verify?data=${payload}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/query string/i);
  });

  it("allows a query string right at the boundary", () => {
    const q = "a".repeat(490);
    expect(resolveEgressUrl(`https://example.com/?q=${q}`).ok).toBe(true);
  });
});

describe("resolveEgressUrl — malformed / non-http protocols", () => {
  it("denies a non-URL string", () => {
    expect(resolveEgressUrl("not a url").ok).toBe(false);
  });

  it("denies file:// and other non-http protocols", () => {
    expect(resolveEgressUrl("file:///etc/passwd").ok).toBe(false);
    expect(resolveEgressUrl("ftp://example.com/x").ok).toBe(false);
  });
});
