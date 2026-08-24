/**
 * FounderOS — talking to a free board over HTTP
 * ==============================================
 * The transport half of the free-board sweep: one request, one timeout, one
 * typed failure. Split out of free-ats-source.ts on 2026-08-22, which the LOC
 * budget caught at 412 lines once conditional requests arrived.
 *
 * The seam is the same one that produced free-ats-endpoints.ts: this file is HOW
 * we ask, free-ats-endpoints.ts is WHAT we know about each platform, and
 * free-ats-source.ts is the retry and sweep policy over both.
 */

import type { EtagCache } from "./free-ats-cache.js";
import type { FreeAts } from "./free-boards.js";
import { getAdapter } from "./adapters/index.js";

export type WireFormat = "json" | "xml";

/** Carries the HTTP status so the retry decision is made on the code, not on a string. */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

/** A per-posting body fetch: JSON, and never cached — see free-ats-cache.ts. */
export async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  return await fetchPayload(url, timeoutMs, "json", null);
}

/** The wire format a platform's board endpoint speaks. */
export function wireFormatFor(ats: FreeAts): WireFormat {
  const adapter = getAdapter(ats);
  if (!adapter) throw new Error(`Unknown ATS platform: ${ats}`);
  return adapter.getWireFormat();
}

/**
 * One board fetch, in whichever wire format the platform speaks.
 *
 * `format` exists because Personio is the first platform whose complete feed is
 * XML rather than JSON — its `search.json` carries an empty description on every
 * job, no date and no URL (verified live 2026-08-22 across 318 postings), so the
 * XML is not a preference but the only source with the fields the gates read.
 * The mapper receives the raw string and parses it; this function's job ends at
 * the transport.
 *
 * `cache` is optional so per-posting body fetches keep the un-cached path.
 */
export async function fetchPayload(
  url: string,
  timeoutMs: number,
  format: WireFormat,
  cache: EtagCache | null,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: format === "json" ? "application/json" : "application/xml, text/xml",
        ...(cache?.headersFor(url) ?? {}),
      },
    });

    // 304 is a SUCCESS, not a miss: the board is unchanged and the payload we
    // already hold is the current answer. `headersFor` only offers a validator
    // while the matching payload is still resident, so this cannot return
    // undefined for an evicted entry.
    if (response.status === 304 && cache) {
      void response.body?.cancel();
      return cache.read(url);
    }

    if (!response.ok) {
      // Read the status before discarding the body, then discard it: an
      // unconsumed body holds the socket open under undici until GC.
      void response.body?.cancel();
      throw new HttpStatusError(response.status);
    }

    const payload = format === "json" ? await response.json() : await response.text();
    // Optional chaining is load-bearing, not defensive noise. A throw inside this
    // try is indistinguishable from a transport failure to `isRetryable`, so a
    // response that simply carries no headers would be retried three times and
    // then reported as a broken board. No headers just means nothing to cache.
    cache?.store(url, response.headers?.get("etag"), payload);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}
