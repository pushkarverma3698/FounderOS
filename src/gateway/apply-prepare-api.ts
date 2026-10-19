/**
 * Apply home: routes and JSON API
 * ===============================
 * The Mini App job list (apply-home.ts) talks to four routes, all mounted from apply-routes.ts:
 *
 *   GET  /apply/home                      the static shell (no user data; CSP nonce per request)
 *   GET  /apply/api/jobs                  {jobs:[{id, rank, company, title, state}]} for the signed-in profile only
 *   POST /apply/api/prepare/<rowId>       202 and prepareRow runs in the background; 409 if one is already running
 *   GET  /apply/api/job-status/<rowId>    {state, detail, url?}; url is the signed answer page once a form is ready
 *
 * Auth on every /api call is Telegram initData (X-Telegram-Init-Data) mapped to a profile (miniapp-auth.ts).
 * A missing or bad header, an unknown row and another profile's row are the same plain 404. The prepare lock
 * is taken before the 202, so two quick taps cannot both start a browser. The card and progress lines go to the
 * signed-in user's private chat (Telegram chat id of a private chat is the user id), the same record as /apply.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getApplicationById, listApplyQueue } from "../db/apply-queries.js";
import type { JobApplication } from "../db/schema.js";
import { logger } from "../infra/logger.js";
import { buildApplyUrl, loadApplySnapshot, readApplyLinkConfig } from "../tools/jobhunt/apply-link.js";
import { getProfile, type JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { computeStatus, type ApiDeps } from "./apply-api.js";
import { homePageHeaders, renderHomePage } from "./apply-home.js";
import { prepareRow } from "./apply-prepare.js";
import { clearOutcome, lockPhase, tryLockApply } from "./apply-session.js";
import { authenticateMiniApp } from "./miniapp-auth.js";

const log = logger.child({ module: "apply-home" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JobsApiDeps {
  readonly listQueue: (profile: JobSearchProfile) => Promise<JobApplication[]>;
  /** The row by id, or null. Ownership is checked by the caller. */
  readonly getRow: (id: string, profile: JobSearchProfile) => Promise<JobApplication | null>;
  readonly prepare: typeof prepareRow;
}

export const defaultJobsApiDeps: JobsApiDeps = {
  listQueue: (profile) => listApplyQueue(profile.tenantId, profile.id),
  getRow: (id, profile) => getApplicationById(id, profile.tenantId),
  prepare: prepareRow,
};

/** Why the last prepare of a row did not produce a form, until the next prepare starts. Memory only, like the outcome map. */
const prepareFailures = new Map<string, string>();

export const clearPrepareFailuresForTests = (): void => prepareFailures.clear();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

const notFound = (res: ServerResponse): void => json(res, 404, { error: "not found" });

type Who = { readonly ok: true; readonly userId: number; readonly profile: JobSearchProfile } | { readonly ok: false };

function whoIs(req: IncomingMessage, deps: ApiDeps): Who {
  const header = req.headers["x-telegram-init-data"];
  const auth = authenticateMiniApp(Array.isArray(header) ? header[0] : header, deps.env, deps.now());
  if (!auth.ok) {
    log.warn({ reason: auth.reason }, "apply home: initData refused");
    return { ok: false };
  }
  try {
    return { ok: true, userId: auth.userId, profile: getProfile(auth.profileId) };
  } catch (err) {
    // allow-failopen: a profile id that no longer resolves is an unauthenticated caller, so the answer is the same 404.
    log.warn({ err: (err as Error).message }, "apply home: profile not found");
    return { ok: false };
  }
}

/** The row, only when it exists and belongs to this profile. */
async function ownedRow(id: string, profile: JobSearchProfile, jobs: JobsApiDeps): Promise<JobApplication | null> {
  if (!UUID.test(id)) return null;
  const row = await jobs.getRow(id, profile);
  return row && row.profile_id === profile.id ? row : null;
}

async function listJobs(res: ServerResponse, who: Extract<Who, { ok: true }>, deps: ApiDeps, jobs: JobsApiDeps): Promise<void> {
  const rows = await jobs.listQueue(who.profile);
  const items = rows
    .filter((r) => r.profile_id === who.profile.id)
    .map((r) => ({
      id: r.id,
      rank: r.brief_rank ?? 0,
      company: r.company,
      title: r.title,
      state: computeStatus(r.id, loadApplySnapshot(r.id, deps.root), deps.now())?.state ?? "idle",
    }));
  json(res, 200, { jobs: items });
}

async function runPrepare(
  row: JobApplication, who: Extract<Who, { ok: true }>, held: () => void, deps: ApiDeps, jobs: JobsApiDeps,
): Promise<void> {
  const chatId = String(who.userId);
  const send = deps.senderFor(chatId);
  try {
    const result = await jobs.prepare(row, who.profile, chatId, send, { held });
    if (result.kind === "refused") prepareFailures.set(row.id, result.detail);
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ rowId: row.id, err: reason }, "apply home: prepare crashed");
    prepareFailures.set(row.id, `The form could not be prepared: ${reason}`);
    try {
      await send.text(`⚠ Could not prepare ${row.company}'s form: ${reason.replace(/[<>&]/g, "")}`);
    } catch (sendErr) {
      // allow-failopen: the page shows the failure through job-status; a lost chat line is only logged.
      log.warn({ rowId: row.id, err: (sendErr as Error).message }, "apply home: could not tell the chat");
    }
  }
}

async function startPrepare(
  res: ServerResponse, rowId: string, who: Extract<Who, { ok: true }>, deps: ApiDeps, jobs: JobsApiDeps,
): Promise<void> {
  const row = await ownedRow(rowId, who.profile, jobs);
  if (!row) return notFound(res);
  const held = tryLockApply(row.id, deps.now(), "prepare");
  if (!held) {
    const status = computeStatus(row.id, loadApplySnapshot(row.id, deps.root), deps.now());
    json(res, 409, { state: status?.state ?? "preparing", detail: status?.detail ?? "This form is already being filled." });
    return;
  }
  prepareFailures.delete(row.id);
  clearOutcome(row.id);
  void runPrepare(row, who, held, deps, jobs);
  json(res, 202, { state: "preparing", detail: "Opening the form and filling it." });
}

async function jobStatus(
  res: ServerResponse, rowId: string, who: Extract<Who, { ok: true }>, deps: ApiDeps, jobs: JobsApiDeps,
): Promise<void> {
  const row = await ownedRow(rowId, who.profile, jobs);
  if (!row) return notFound(res);
  const snap = loadApplySnapshot(row.id, deps.root);
  const running = lockPhase(row.id, deps.now());
  const failure = running ? undefined : prepareFailures.get(row.id);
  if (failure) return json(res, 200, { state: "failed", detail: failure });
  const status = computeStatus(row.id, snap, deps.now());
  const cfg = readApplyLinkConfig(deps.env);
  const url = snap && snap.profileId === who.profile.id && !running && cfg.ok ? buildApplyUrl(cfg, row.id, who.profile.id, deps.now()) : undefined;
  json(res, 200, { state: status?.state ?? "idle", detail: status?.detail ?? "", ...(url ? { url } : {}) });
}

/**
 * Handles `home` and `api/...` under /apply/. Returns false when the path is not one of ours, so the caller
 * falls through to the answer-page routes. `parts` is the path after /apply/, split on "/".
 */
export async function handleHomeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
  deps: ApiDeps,
  jobs: JobsApiDeps = defaultJobsApiDeps,
): Promise<boolean> {
  const [head, kind, rowId = ""] = parts;
  const method = req.method ?? "";
  if (head === "home" && parts.length === 1) {
    if (method !== "GET") {
      res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
      return true;
    }
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, homePageHeaders(nonce));
    res.end(renderHomePage(nonce));
    return true;
  }
  if (head !== "api") return false;
  const want = kind === "jobs" && parts.length === 2 ? "GET"
    : kind === "prepare" && parts.length === 3 ? "POST"
    : kind === "job-status" && parts.length === 3 ? "GET"
    : null;
  if (want === null) {
    notFound(res);
    return true;
  }
  if (method !== want) {
    res.writeHead(405, { Allow: want, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return true;
  }
  const who = whoIs(req, deps);
  if (!who.ok) {
    notFound(res);
    return true;
  }
  if (kind === "jobs") await listJobs(res, who, deps, jobs);
  else if (kind === "prepare") await startPrepare(res, rowId, who, deps, jobs);
  else await jobStatus(res, rowId, who, deps, jobs);
  return true;
}
