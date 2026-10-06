/**
 * HTTP observer for an outcome oracle. GET only, https only, and only to hosts the caller allows
 * (the founder's own). A target that fails any check returns an error and never reaches fetch.
 * Redirects are not followed, so an allowlisted host cannot bounce us to a host that is not.
 */

import type { Oracle } from "./oracle.js";

export interface FetchInit {
  method: "GET";
  redirect: "manual";
  signal: AbortSignal;
}
export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export type HttpObservation = { actual: { status: number; body: unknown } } | { error: string };

const MAX_BODY_CHARS = 1_000_000;

function checkTarget(target: string, allowedHosts: readonly string[]): { href: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    // allow-failopen: an unparsable target is returned as an error; no request is made
    return { error: "target is not a valid URL" };
  }
  if (url.protocol !== "https:") return { error: `target must be https, got ${url.protocol}` };
  if (url.username !== "" || url.password !== "") return { error: "target must not embed credentials" };
  if (url.port !== "") return { error: "target must use the default https port" };
  const allowed = new Set(allowedHosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== ""));
  if (!allowed.has(url.hostname)) return { error: `host "${url.hostname}" is not on the allowlist` };
  return { href: url.href };
}

export async function observeHttp(
  oracle: Oracle,
  fetchImpl: FetchLike,
  timeoutMs: number,
  allowedHosts: readonly string[],
): Promise<HttpObservation> {
  if (oracle.kind !== "http") return { error: `oracle kind is ${oracle.kind}, not http` };
  if (!oracle.target) return { error: "http oracle has no target" };
  const checked = checkTarget(oracle.target, allowedHosts);
  if ("error" in checked) return checked;

  const ctrl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("timeout"));
      ctrl.abort();
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([fetchImpl(checked.href, { method: "GET", redirect: "manual", signal: ctrl.signal }), deadline]);
    const text = await Promise.race([res.text(), deadline]);
    if (text.length > MAX_BODY_CHARS) return { error: "response body too large" };
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // allow-failopen: a non-JSON body is kept as text, which is the intended fallback
    }
    return { actual: { status: res.status, body } };
  } catch (err) {
    // allow-failopen: any transport failure is reported as an error observation, which the caller maps to UNKNOWN
    if (timedOut) return { error: `request timed out after ${timeoutMs}ms` };
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
