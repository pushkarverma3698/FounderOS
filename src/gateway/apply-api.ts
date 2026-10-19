/**
 * Apply answer page: Mini App API
 * ===============================
 * Four JSON endpoints under the answer-page link, for the page running inside Telegram:
 *
 *   GET  /apply/<token>/status   {state, detail, missingRequired[]}
 *   POST /apply/<token>/submit   202, then the shared Submit (apply-submit.ts) runs in the background
 *   POST /apply/<token>/cancel   the same end as the Telegram Cancel button
 *   POST /apply/<token>/code     {code}: the founder types the emailed confirmation code into the held form
 *   POST /apply/<token>/submitted {createdAt}: an unconfirmed row the founder sent from his own browser is marked applied
 *
 * Two proofs on every call: the HMAC link (the page exists for this row) and Telegram WebApp initData in
 * the X-Telegram-Init-Data header (the signed-in Telegram user is the profile that owns the row, ADR-018).
 * Every failure of either is the same plain 404, so nothing reveals which rows have a session.
 * Submit takes the per-row lock the Telegram path takes, checks the page is not older than the snapshot,
 * and reports the outcome to the chat as the Telegram path does.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../infra/logger.js";
import { sendPhoto } from "../infra/telegram-send.js";
import { loadApplySnapshot, parseApplyToken, readApplyLinkConfig, verifyApplyToken, type ApplySnapshot } from "../tools/jobhunt/apply-link.js";
import { heldCodeInfo, CODE_PATTERN, namesHiddenBotCheck } from "../tools/jobhunt/held-submit.js";
import { runCodeEntry, runSubmit, settleSubmittedByHand, type SubmitIo } from "./apply-submit.js";
import {
  clearOutcome, endSession, lockPhase, outcomeFor, recordOutcome, tryLockApply, unconfirmedClickAt, unconfirmedEvidenceFor, type ApplySender,
} from "./apply-session.js";
import { escapeHtml } from "./apply-page.js";
import { authenticateMiniApp } from "./miniapp-auth.js";

const log = logger.child({ module: "apply-api" });

export const MAX_BODY_BYTES = 64 * 1024;
export const TOO_LARGE = Symbol("too-large");

export type ApplyState = "preparing" | "ready" | "blocked" | "submitting" | "confirmed" | "unconfirmed" | "cancelled" | "refilling" | "code-needed";
export interface ApplyStatus {
  readonly state: ApplyState;
  readonly detail: string;
  readonly missingRequired: readonly string[];
}

/** What the API needs from the route deps (apply-routes.ts passes its own, which is a superset). */
export interface ApiDeps {
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly root?: string;
  readonly senderFor: (chatId: string) => ApplySender;
  readonly submit: typeof runSubmit;
  readonly enterCode?: typeof runCodeEntry;
  /** Marks an unconfirmed row applied after the founder sent it himself; defaults to the real one. */
  readonly markByHand?: typeof settleSubmittedByHand;
  readonly photoTo: (chatId: string, png: Buffer, caption: string, filename: string) => Promise<void>;
}

export const defaultPhotoTo: ApiDeps["photoTo"] = (chatId, png, caption, filename) => sendPhoto(png, { chatId, caption, filename });

/** The whole body as text, or TOO_LARGE as soon as it passes the cap (the rest is dropped, not buffered). */
export function readBody(req: IncomingMessage): Promise<string | typeof TOO_LARGE> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      resolve(TOO_LARGE);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        resolve(TOO_LARGE);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
      settled = true;
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

const notFound = (res: ServerResponse): void => json(res, 404, { error: "not found" });

/** Where the row stands. Null when there is nothing to say (no snapshot and no remembered outcome). */
export function computeStatus(rowId: string, snap: ApplySnapshot | null, nowMs: number): ApplyStatus | null {
  const phase = lockPhase(rowId, nowMs);
  if (phase === "submit") return { state: "submitting", detail: "Submitting the application. This takes about a minute.", missingRequired: [] };
  if (phase === "refill") return { state: "refilling", detail: "Saving your answers and re-filling the form.", missingRequired: [] };
  if (phase === "prepare") return { state: "preparing", detail: "Opening the form and filling it.", missingRequired: [] };
  const outcome = outcomeFor(rowId);
  const codeHeld = heldCodeInfo(rowId, nowMs);
  if (codeHeld) {
    const retry = outcome?.state === "failed" ? outcome.detail + " " : "";
    const detail = `${retry}Type the code that was emailed to you. ${codeHeld.secondsLeft} seconds left.`;
    return { state: "code-needed", detail, missingRequired: [] };
  }
  if (!snap) {
    if (outcome?.state === "confirmed" || outcome?.state === "cancelled") return { state: outcome.state, detail: outcome.detail, missingRequired: [] };
    return null;
  }
  if (snap.unconfirmedAt !== undefined || unconfirmedClickAt(rowId)) {
    const why = snap.unconfirmedEvidence ?? unconfirmedEvidenceFor(rowId);
    if (namesHiddenBotCheck(why)) {
      const detail = "The form's bot check most likely refused the bot's click, so it was probably not sent. Submit it yourself from the job link below, then tap I submitted it.";
      return { state: "unconfirmed", detail, missingRequired: [] };
    }
    const detail =
      "Submit was clicked but no confirmation came back, so it may have arrived. Check your email first; if nothing came, submit it yourself from the job link below, then tap I submitted it." +
      (why ? ` What the bot saw: ${why}` : "");
    return { state: "unconfirmed", detail, missingRequired: [] };
  }
  const missing = snap.summary.unanswered.filter((q) => q.required).map((q) => q.label);
  if (missing.length > 0) return { state: "blocked", detail: "Required questions are still open.", missingRequired: missing };
  if (snap.summary.hasCaptcha) return { state: "blocked", detail: "This form has a CAPTCHA the bot cannot solve.", missingRequired: [] };
  const failed = outcome?.state === "failed" ? outcome.detail : "Ready to submit.";
  return { state: "ready", detail: failed, missingRequired: [] };
}

type OkAuth = { readonly ok: true; readonly rowId: string; readonly profileId: string; readonly snap: ApplySnapshot | null };
type Authorized = OkAuth | { readonly ok: false };

/** Link signature, then initData for the profile that owns the row. After a confirmed or cancelled end the snapshot is gone; the remembered outcome carries the owner. */
function authorize(req: IncomingMessage, token: string, deps: ApiDeps): Authorized {
  const cfg = readApplyLinkConfig(deps.env);
  if (!cfg.ok) return { ok: false };
  const parsed = parseApplyToken(token);
  if (!parsed) return { ok: false };
  const snap = loadApplySnapshot(parsed.rowId, deps.root);
  const profileId = snap?.profileId ?? outcomeFor(parsed.rowId)?.profileId;
  if (!profileId) return { ok: false };
  if (!verifyApplyToken(cfg.secret, token, profileId, deps.now()).ok) return { ok: false };
  const header = req.headers["x-telegram-init-data"];
  const who = authenticateMiniApp(Array.isArray(header) ? header[0] : header, deps.env, deps.now());
  if (!who.ok) {
    log.warn({ reason: who.reason }, "apply api: initData refused");
    return { ok: false };
  }
  if (who.profileId !== profileId) return { ok: false };
  return { ok: true, rowId: parsed.rowId, profileId, snap };
}

/** Chat and photo writes after a send must never turn a sent application into a reported failure. */
function safeIo(snap: ApplySnapshot, deps: ApiDeps): SubmitIo {
  const sender = deps.senderFor(snap.chatId);
  const guard = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      // allow-failopen: the send itself already happened or failed on its own terms; a lost chat line is logged, never a reason to claim the send failed.
      log.warn({ rowId: snap.rowId, what, err: (err as Error).message }, "apply api: chat delivery failed");
    }
  };
  return {
    text: (html, keyboard) => guard("text", () => sender.text(html, keyboard)),
    photo: (png, caption, filename) => guard("photo", () => deps.photoTo(snap.chatId, png, caption, filename)),
    started: async () => undefined,
    settled: async () => undefined,
  };
}

async function runApiSubmit(snap: ApplySnapshot, held: () => void, deps: ApiDeps): Promise<void> {
  const io = safeIo(snap, deps);
  try {
    const result = await deps.submit(snap.rowId, snap.chatId, "miniapp", io);
    if (result.kind === "refused") {
      recordOutcome(snap.rowId, snap.profileId, "failed", result.toast);
      await io.text(result.html ?? escapeHtml(result.toast));
    } else if (result.kind === "confirmed") {
      recordOutcome(snap.rowId, snap.profileId, "confirmed", result.detail);
    } else if (result.kind === "failed") {
      recordOutcome(snap.rowId, snap.profileId, "failed", "The send did not go out: " + result.detail);
    } else {
      clearOutcome(snap.rowId); // unconfirmed: the snapshot carries the guard, and the status reads it from there
    }
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ rowId: snap.rowId, err: reason }, "apply api: submit crashed");
    recordOutcome(snap.rowId, snap.profileId, "failed", "The send crashed: " + reason);
    await io.text(`⚠ Submit crashed for ${escapeHtml(snap.company)}: ${escapeHtml(reason)}`);
  } finally {
    held();
  }
}

/** The page's snapshot stamp from the body; a 413 or 400 is already sent when this returns null. */
async function readCreatedAt(req: IncomingMessage, res: ServerResponse): Promise<number | null> {
  const raw = await readBody(req);
  if (raw === TOO_LARGE) {
    json(res, 413, { error: "request too large" });
    return null;
  }
  let createdAt: unknown;
  try {
    createdAt = (JSON.parse(raw) as { createdAt?: unknown }).createdAt;
  } catch {
    // allow-failopen: an unreadable body is the same 400 as a body without the stamp.
    createdAt = undefined;
  }
  if (typeof createdAt === "number") return createdAt;
  json(res, 400, { error: "createdAt is required" });
  return null;
}

const STALE_DETAIL = "This page is out of date. Reload it to see the latest form.";

async function submitEndpoint(req: IncomingMessage, res: ServerResponse, a: OkAuth, deps: ApiDeps): Promise<void> {
  const createdAt = await readCreatedAt(req, res);
  if (createdAt === null) return;
  const snap = a.snap;
  const now = deps.now();
  const status = computeStatus(a.rowId, snap, now);
  if (!snap || !status) return json(res, 409, { state: "cancelled", detail: "This form is closed.", missingRequired: [] });
  if (snap.createdAt !== createdAt) {
    return json(res, 409, { state: status.state, detail: STALE_DETAIL, missingRequired: status.missingRequired, stale: true });
  }
  if (status.state !== "ready") return json(res, 409, status);
  const held = tryLockApply(a.rowId, now, "submit");
  if (!held) return json(res, 409, { state: "submitting", detail: "Another run is on this application.", missingRequired: [] });
  recordOutcome(a.rowId, a.profileId, "submitting", "Submitting the application.");
  log.info({ rowId: a.rowId }, "apply api: submit accepted");
  json(res, 202, { state: "submitting", detail: "Submitting the application. This takes about a minute.", missingRequired: [] });
  void runApiSubmit(snap, held, deps);
}

/** "I submitted it": the founder sent an unconfirmed application from his own browser. Marks it applied, nothing is sent. */
async function submittedEndpoint(req: IncomingMessage, res: ServerResponse, a: OkAuth, deps: ApiDeps): Promise<void> {
  const createdAt = await readCreatedAt(req, res);
  if (createdAt === null) return;
  const snap = a.snap;
  const now = deps.now();
  const status = computeStatus(a.rowId, snap, now);
  if (!snap || !status) return json(res, 409, { state: "cancelled", detail: "This form is closed.", missingRequired: [] });
  if (snap.createdAt !== createdAt) {
    return json(res, 409, { state: status.state, detail: STALE_DETAIL, missingRequired: status.missingRequired, stale: true });
  }
  if (status.state !== "unconfirmed") return json(res, 409, status);
  const held = tryLockApply(a.rowId, now, "submit");
  if (!held) return json(res, 409, { state: "submitting", detail: "Another run is on this application.", missingRequired: [] });
  try {
    const result = await (deps.markByHand ?? settleSubmittedByHand)(a.rowId, safeIo(snap, deps));
    if (result.kind === "confirmed") {
      recordOutcome(a.rowId, a.profileId, "confirmed", result.detail);
      log.info({ rowId: a.rowId }, "apply api: marked applied by hand");
      return json(res, 200, { state: "confirmed", detail: result.detail, missingRequired: [] });
    }
    const detail = result.kind === "refused" ? result.toast : result.detail;
    return json(res, result.kind === "failed" ? 500 : 409, { state: status.state, detail, missingRequired: [] });
  } finally {
    held();
  }
}

async function runApiCode(snap: ApplySnapshot, code: string, held: () => void, deps: ApiDeps): Promise<void> {
  const io = safeIo(snap, deps);
  try {
    const result = await (deps.enterCode ?? runCodeEntry)(snap.rowId, "miniapp", code, io);
    if (result.kind === "confirmed") recordOutcome(snap.rowId, snap.profileId, "confirmed", result.detail);
    else if (result.kind === "code-needed" || result.kind === "invalid") recordOutcome(snap.rowId, snap.profileId, "failed", result.detail);
    else clearOutcome(snap.rowId); // unconfirmed or none: the snapshot carries the guard, and the status reads it from there
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ rowId: snap.rowId, err: reason }, "apply api: code entry crashed");
    recordOutcome(snap.rowId, snap.profileId, "failed", "Entering the code crashed: " + reason);
  } finally {
    held();
  }
}

async function codeEndpoint(req: IncomingMessage, res: ServerResponse, a: OkAuth, deps: ApiDeps): Promise<void> {
  const raw = await readBody(req);
  if (raw === TOO_LARGE) return json(res, 413, { error: "request too large" });
  let code: unknown;
  try {
    code = (JSON.parse(raw) as { code?: unknown }).code;
  } catch {
    // allow-failopen: an unreadable body is the same 400 as a body without a code.
    code = undefined;
  }
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
    return json(res, 400, { error: "The code is 4 to 12 letters and digits." });
  }
  const now = deps.now();
  if (!a.snap || !heldCodeInfo(a.rowId, now)) {
    return json(res, 409, { state: "cancelled", detail: "No form is waiting for a code.", missingRequired: [] });
  }
  const held = tryLockApply(a.rowId, now, "submit");
  if (!held) return json(res, 409, { state: "submitting", detail: "Another run is on this application.", missingRequired: [] });
  log.info({ rowId: a.rowId }, "apply api: code accepted");
  json(res, 202, { state: "submitting", detail: "Entering the code and submitting.", missingRequired: [] });
  void runApiCode(a.snap, code, held, deps);
}

async function cancelEndpoint(res: ServerResponse, a: OkAuth, deps: ApiDeps): Promise<void> {
  const done = { state: "cancelled", detail: "Cancelled. Tap Prepare again for a fresh form.", missingRequired: [] };
  if (!a.snap) return json(res, 200, done);
  if (lockPhase(a.rowId, deps.now()) === "submit") {
    return json(res, 409, { state: "submitting", detail: "A submit is running, so it cannot be cancelled now.", missingRequired: [] });
  }
  recordOutcome(a.rowId, a.profileId, "cancelled", done.detail);
  endSession(a.rowId, deps.root);
  try {
    await deps.senderFor(a.snap.chatId).text("⏭ Cancelled auto-apply session.");
  } catch (err) {
    // allow-failopen: the session is already ended; a lost chat line must not turn the cancel into an error.
    log.warn({ rowId: a.rowId, err: (err as Error).message }, "apply api: could not tell the chat about the cancel");
  }
  json(res, 200, done);
}

/** The path after the token: status, submit, cancel, code or submitted. A bad link, bad initData or wrong profile is a 404. */
export async function handleApplyApi(req: IncomingMessage, res: ServerResponse, token: string, action: string, deps: ApiDeps): Promise<void> {
  const method = req.method ?? "";
  const want = action === "status" ? "GET" : ["submit", "cancel", "code", "submitted"].includes(action) ? "POST" : null;
  if (!want) return notFound(res);
  if (method !== want) {
    res.setHeader("Allow", want);
    return json(res, 405, { error: "method not allowed" });
  }
  const a = authorize(req, token, deps);
  if (!a.ok) return notFound(res);
  if (action === "status") {
    const status = computeStatus(a.rowId, a.snap, deps.now());
    return status ? json(res, 200, status) : notFound(res);
  }
  if (action === "submit") return submitEndpoint(req, res, a, deps);
  if (action === "code") return codeEndpoint(req, res, a, deps);
  if (action === "submitted") return submittedEndpoint(req, res, a, deps);
  return cancelEndpoint(res, a, deps);
}
