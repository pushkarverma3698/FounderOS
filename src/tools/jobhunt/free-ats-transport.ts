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
import type { BoardRequest } from "./adapters/types.js";

export type WireFormat = "json" | "xml";

/** Carries the HTTP status so the retry decision is made on the code, not on a string. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
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
  request?: BoardRequest,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const method = request?.method ?? "GET";
  // A POST carries its page offset in the BODY while the URL stays constant, so a
  // URL-keyed validator cache would serve page 1's payload for every later page.
  // Conditional requests are a GET-only optimisation here, deliberately.
  const validators = method === "GET" && cache ? await cache.headersFor(url) : {};
  const send = async (withValidators: Record<string, string>): Promise<Response> =>
    await fetch(url, {
      method,
      signal: controller.signal,
      ...(request?.body === undefined ? {} : { body: request.body }),
      headers: {
        accept: format === "json" ? "application/json" : "application/xml, text/xml",
        ...(request?.body === undefined ? {} : { "content-type": "application/json" }),
        ...withValidators,
      },
    });

  try {
    let response = await send(validators);

    if (response.status === 304 && cache) {
      void response.body?.cancel();
      const cached = await cache.read(url);
      if (cached !== undefined) return cached;
      // The validator and the payload no longer come from the same read. Since
      // the cache moved to Postgres, `headersFor` and `read` are two separate
      // round trips, so the row can be dropped between them — and `read` fails
      // open to `undefined` when the cache DB errors after `headersFor` already
      // succeeded. A 304 has no body, so returning that `undefined` hands the
      // adapter an empty board: zero candidates, counted as neither a failure
      // nor a find, indistinguishable from an employer with no openings. Ask
      // again without the validator instead. A cache miss must cost bandwidth,
      // never correctness.
      response = await send({});
    }

    if (!response.ok) {
      void response.body?.cancel();
      const retryAfter = response.headers?.get("retry-after");
      let retryAfterMs: number | undefined;
      if (retryAfter) {
        const asSec = parseInt(retryAfter, 10);
        if (!Number.isNaN(asSec)) {
          retryAfterMs = asSec * 1000;
        } else {
          const asDate = new Date(retryAfter).getTime();
          if (!Number.isNaN(asDate)) {
            retryAfterMs = Math.max(0, asDate - Date.now());
          }
        }
      }
      throw new HttpStatusError(response.status, retryAfterMs);
    }

    const payload = format === "json" ? await response.json() : await response.text();
    
    if (cache) {
      await cache.store(url, response.headers?.get("etag"), payload);
    }
    
    return payload;
  } finally {
    clearTimeout(timer);
  }
}
