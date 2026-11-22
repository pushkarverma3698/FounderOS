/**
 * Mac worker API: /apply/mac-worker/*
 * ===================================
 * For the Mac worker that applies to CAPTCHA-blocked forms (Lever, Recruitee, SmartRecruiters, Greenhouse) from a real
 * Chrome. It sits under /apply/ because that is the path the public proxy already forwards to the jobs health server.
 *
 *   POST /apply/mac-worker/lease       200 {leaseId, rowId, leaseUntil}, or 204 when nothing is eligible
 *   GET  /apply/mac-worker/packet      ?rowId&leaseId: url, answers, plan, cv, auditKey
 *   GET  /apply/mac-worker/cv          ?rowId&leaseId: the resume PDF
 *   POST /apply/mac-worker/result      {rowId, leaseId, outcome: confirmed|challenge|failed|code_needed, detail, proofScreenshot?}
 *   POST /apply/mac-worker/heartbeat   200; macOnline() reads it
 *
 * Auth is its own bearer token (MAC_WORKER_TOKEN, compared in constant time), never the Mini App session. With the
 * token unset every path is the plain 404 of an unknown route. Nothing here clicks Submit or contacts an employer:
 * the Mac does that in its own browser and reports back. A confirmed report goes through the same settle path as the
 * other surfaces (apply-submit.ts: applied, the job_application_submitted audit row under auditKeyFor, via "mac").
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { macWorkerToken } from "../core/config.js";
import { extendLease, getLeasedRow, leaseNextRow, recordMacBeat, releaseLease } from "../db/mac-worker-queries.js";
import type { JobApplication } from "../db/schema.js";
import { logger } from "../infra/logger.js";
import { jobsChatId, sendMessageTo, sendPhoto } from "../infra/telegram-send.js";
import { bearerOf, MAC_LEASE_TTL_MS, MAC_MAX_PROOF_CHARS, parseResultBody, tokenMatches, type MacResultBody } from "../tools/jobhunt/mac-worker-rules.js";
import { listProfiles } from "../tools/jobhunt/profile-config.js";
import { readBody, TOO_LARGE } from "./apply-api.js";
import { appliedOn } from "./apply-material.js";
import { tryLockApply } from "./apply-session.js";
import { settleConfirmed } from "./apply-submit.js";
import { buildMacPacket, resolveCv, targetUrlOf } from "./mac-worker-packet.js";
import { safeHtml } from "./safe-html.js";

const log = logger.child({ module: "mac-worker-api" });

const PREFIX = "/apply/mac-worker/";
const RESULT_BODY_LIMIT = MAC_MAX_PROOF_CHARS + 16 * 1024;

export interface MacWorkerDeps {
  readonly now: () => Date;
  readonly token: () => string | undefined;
  readonly profileIds: () => readonly string[];
  readonly lease: typeof leaseNextRow;
  readonly getLeased: typeof getLeasedRow;
  readonly extend: typeof extendLease;
  readonly release: typeof releaseLease;
  readonly beat: typeof recordMacBeat;
  readonly packet: typeof buildMacPacket;
  readonly cv: typeof resolveCv;
  readonly settle: typeof settleConfirmed;
  readonly notify: (html: string) => Promise<void>;
  readonly photo: (png: Buffer, caption: string, filename: string) => Promise<void>;
}

export function defaultMacWorkerDeps(): MacWorkerDeps {
  return {
    now: () => new Date(), token: macWorkerToken, profileIds: () => listProfiles().map((p) => p.id),
    lease: leaseNextRow, getLeased: getLeasedRow, extend: extendLease, release: releaseLease, beat: recordMacBeat,
    packet: buildMacPacket, cv: resolveCv, settle: settleConfirmed,
    notify: (html) => sendMessageTo(jobsChatId(), html, { parse_mode: "HTML" }),
    photo: (png, caption, filename) => sendPhoto(png, { chatId: jobsChatId(), caption, filename }),
  };
}

export const isMacWorkerPath = (url: string | undefined): boolean => (url ?? "").split("?")[0]?.startsWith(PREFIX) === true;

function reply(res: ServerResponse, status: number, body?: unknown): void {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const label = (row: JobApplication): string => `<b>${safeHtml(row.company)}</b> (${safeHtml(row.title)})`;

/** The lease check every per-row call makes: the row, only while `leaseId` is the lease on it. */
async function leasedRow(rowId: string | null, leaseId: string | null, deps: MacWorkerDeps): Promise<JobApplication | null> {
  if (!rowId || !leaseId) return null;
  return deps.getLeased(rowId, leaseId);
}

async function handleConfirmed(res: ServerResponse, row: JobApplication, body: MacResultBody, deps: MacWorkerDeps): Promise<void> {
  const now = deps.now();
  if (appliedOn(row)) {
    await deps.release(row.id, body.leaseId, "confirmed", now);
    reply(res, 200, { ok: true, already: true });
    return;
  }
  const release = tryLockApply(row.id, now.getTime(), "submit");
  if (!release) {
    reply(res, 409, { error: "the row is being sent or settled right now" });
    return;
  }
  try {
    if (body.proofScreenshot) {
      try {
        await deps.photo(Buffer.from(body.proofScreenshot, "base64"), `${row.company} — Mac proof`, `mac-proof-${row.id.slice(0, 8)}.png`);
      } catch (err) {
        // allow-failopen: the proof photo is a courtesy; the application is real and must still be recorded.
        log.warn({ rowId: row.id, err: (err as Error).message }, "mac worker: proof screenshot not delivered");
      }
    }
    const io = { text: deps.notify, photo: deps.photo, started: async () => undefined, settled: async () => undefined };
    await deps.settle(row, "mac", targetUrlOf(row), io);
    await deps.release(row.id, body.leaseId, "confirmed", now);
  } finally {
    release();
  }
  reply(res, 200, { ok: true });
}

async function handleResult(req: IncomingMessage, res: ServerResponse, deps: MacWorkerDeps): Promise<void> {
  const raw = await readBody(req, RESULT_BODY_LIMIT);
  if (raw === TOO_LARGE) return reply(res, 413, { error: "body too large" });
  const parsed = parseResultBody(raw);
  if (!parsed.ok) return reply(res, 400, { error: parsed.error });
  const body = parsed.body;
  const row = await deps.getLeased(body.rowId, body.leaseId);
  if (!row) return reply(res, 409, { error: "this row is not leased by that lease" });
  const now = deps.now();
  const detail = body.detail.slice(0, 300);
  if (body.outcome === "confirmed") return handleConfirmed(res, row, body, deps);
  if (body.outcome === "failed") {
    await deps.release(row.id, body.leaseId, `failed: ${detail || "no detail"}`, now);
    log.info({ rowId: row.id, detail }, "mac worker: failed, lease cleared");
    return reply(res, 200, { ok: true });
  }
  // challenge and code_needed: a person must act on the Mac, so the lease stays and is extended by a full 30 minutes.
  const until = new Date(now.getTime() + MAC_LEASE_TTL_MS);
  if (!(await deps.extend(row.id, body.leaseId, until, body.outcome, now))) return reply(res, 409, { error: "lease lost" });
  const ping = body.outcome === "challenge"
    ? `🖱 Click the check on your Mac: ${label(row)} is waiting on a bot check in Chrome.`
    : `📧 ${label(row)} emailed a confirmation code. Type it into Chrome on your Mac.`;
  try {
    await deps.notify(ping);
  } catch (err) {
    // allow-failopen: the lease is already extended; a lost ping is logged, and the digest still lists the row.
    log.error({ rowId: row.id, err: (err as Error).message }, "mac worker: could not send the Telegram ping");
  }
  reply(res, 200, { ok: true, leaseUntil: until.toISOString() });
}

async function route(req: IncomingMessage, res: ServerResponse, action: string, query: URLSearchParams, deps: MacWorkerDeps): Promise<void> {
  const method = req.method ?? "";
  const want = (m: string): boolean => {
    if (method === m) return true;
    reply(res, 405, { error: "method not allowed" });
    return false;
  };
  if (action === "lease") {
    if (!want("POST")) return;
    const leaseId = randomUUID();
    const row = await deps.lease(deps.profileIds(), deps.now(), leaseId, MAC_LEASE_TTL_MS);
    if (!row) return reply(res, 204);
    return reply(res, 200, { leaseId, rowId: row.id, leaseUntil: row.mac_lease_until?.toISOString() ?? null });
  }
  if (action === "heartbeat") {
    if (!want("POST")) return;
    await deps.beat(deps.now());
    return reply(res, 200, { ok: true });
  }
  if (action === "result") {
    if (!want("POST")) return;
    return handleResult(req, res, deps);
  }
  if (action === "packet" || action === "cv") {
    if (!want("GET")) return;
    const row = await leasedRow(query.get("rowId"), query.get("leaseId"), deps);
    if (!row || !row.mac_lease_until || row.mac_lease_until <= deps.now()) return reply(res, 409, { error: "no live lease on that row" });
    if (appliedOn(row)) return reply(res, 409, { error: "already applied" });
    if (action === "packet") {
      const built = await deps.packet(row);
      return built.ok ? reply(res, 200, built.packet) : reply(res, 422, { error: built.reason });
    }
    const cv = await deps.cv(row);
    if (!cv.ok) return reply(res, 422, { error: cv.reason });
    const pdf = await fs.readFile(cv.path);
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length, "Cache-Control": "no-store" });
    res.end(pdf);
    return;
  }
  reply(res, 404, { error: "not found" });
}

/** Entry point for `/apply/mac-worker/...`. Never throws; an unexpected error is a plain 500. */
export async function handleMacWorkerRequest(req: IncomingMessage, res: ServerResponse, deps: MacWorkerDeps = defaultMacWorkerDeps()): Promise<void> {
  try {
    const expected = deps.token();
    if (!expected) return reply(res, 404, { error: "not found" });
    if (!tokenMatches(bearerOf(req.headers["authorization"]), expected)) return reply(res, 401, { error: "unauthorized" });
    const [path = "", search = ""] = (req.url ?? "").split("?");
    await route(req, res, path.slice(PREFIX.length), new URLSearchParams(search), deps);
  } catch (err) {
    log.error({ err: (err as Error).message }, "mac worker request failed");
    if (!res.headersSent) reply(res, 500, { error: "something went wrong" });
    else res.end();
  }
}
