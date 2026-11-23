/**
 * Mac worker API: the pure parts
 * ==============================
 * Constants and rules with no I/O, so the lease and result rules are unit-tested without a server or a database.
 * The I/O is in db/mac-worker-queries.ts (the lease) and gateway/mac-worker-api.ts (the HTTP routes).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** A lease lasts 30 minutes; a challenge or code ping extends it by the same amount. */
export const MAC_LEASE_TTL_MS = 30 * 60 * 1000;
/** The Mac counts as online for 30 minutes after its last heartbeat. */
export const MAC_ONLINE_MS = 30 * 60 * 1000;
/** A row is leased to the Mac at most this many times, so a form that keeps failing stops coming back. */
export const MAC_MAX_ATTEMPTS = 3;
/** Rows routed to hand_off longer ago than this are not leased: the posting has likely closed. */
export const MAC_ROW_WINDOW_MS = 48 * 60 * 60 * 1000;
/** The largest accepted proof screenshot, as base64 text. */
export const MAC_MAX_PROOF_CHARS = 6 * 1024 * 1024;

/**
 * The hand_off reasons a person solves with a click (apply-lane.ts words them: "CAPTCHA or reCAPTCHA widget...",
 * "Bot check blocks automation: ..."). Workday, expired and unusable-form reasons are not the Mac's to try.
 * One source string, used by the SQL (`~*`) and by `isMacEligibleReason`, so the two cannot drift.
 */
export const MAC_REASON_PATTERN = "captcha|bot[ -]check|turnstile";
const MAC_REASON_RE = new RegExp(MAC_REASON_PATTERN, "i");

export const isMacEligibleReason = (reason: string | null | undefined): boolean => MAC_REASON_RE.test(reason ?? "");

/** True when the Mac checked in within the last 30 minutes. Never beat: offline. */
export function macOnline(lastBeat: Date | null | undefined, now: Date): boolean {
  if (!lastBeat) return false;
  const age = now.getTime() - lastBeat.getTime();
  return age >= 0 && age <= MAC_ONLINE_MS;
}

/** Constant-time bearer check. Both sides are hashed first so the compared buffers always have the same length. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The token out of `Authorization: Bearer <token>`, or undefined. */
export function bearerOf(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)$/i.exec(raw ?? "");
  return m?.[1];
}

/** `mac_result` starts with this when Submit was clicked and nothing confirmed it; the lease query and cooldown read it. */
export const MAC_UNCONFIRMED_PREFIX = "unconfirmed:";

/** `unconfirmed`: Submit was clicked, outcome unknown (never retried). `dry_run`: a dry run ended, no attempt is spent. */
export const OUTCOMES = ["confirmed", "challenge", "failed", "code_needed", "unconfirmed", "dry_run"] as const;
export type MacOutcome = (typeof OUTCOMES)[number];

export const resultBodySchema = z.object({
  rowId: z.string().uuid(),
  leaseId: z.string().min(8).max(100),
  outcome: z.enum(OUTCOMES),
  detail: z.string().max(1000).default(""),
  proofScreenshot: z.string().max(MAC_MAX_PROOF_CHARS).optional(),
});
export type MacResultBody = z.infer<typeof resultBodySchema>;

export function parseResultBody(raw: string): { readonly ok: true; readonly body: MacResultBody } | { readonly ok: false; readonly error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // allow-failopen: a body that is not JSON is the caller's mistake; it is answered with a 400.
    return { ok: false, error: "body is not JSON" };
  }
  const parsed = resultBodySchema.safeParse(json);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") };
}
