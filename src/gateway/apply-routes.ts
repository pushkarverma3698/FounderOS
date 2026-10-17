/**
 * Apply answer page: HTTP routes
 * ==============================
 * Mounted by the jobs health server (127.0.0.1) under /apply/. Tailscale Funnel proxies the public
 * path to it, so everything below treats the request as hostile:
 *
 *   GET  /apply/<token>   the page for one application row.
 *   POST /apply/<token>   save the answers, then re-fill and send a fresh card to Telegram.
 *
 * The token is `<rowId>.<expUnix>.<sig>` (tools/jobhunt/apply-link.ts). Every failure that could
 * reveal something (no config, bad shape, no snapshot, wrong signature, wrong profile) is the same
 * plain 404; an expired link is 410, and only for a genuine signature. A POST accepts only answers
 * the stored snapshot offered, caps the body, takes the per-row lock that the Telegram path also
 * takes, and NEVER submits: Submit stays the Telegram button behind its HITL gate.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../infra/logger.js";
import { recordLearnedAnswer } from "../tools/jobhunt/candidate-dossier.js";
import {
  loadApplySnapshot,
  parseApplyToken,
  readApplyLinkConfig,
  verifyApplyToken,
  type ApplySnapshot,
} from "../tools/jobhunt/apply-link.js";
import { collectAnswers } from "./apply-answers.js";
import { refillFromPage } from "./apply-flow.js";
import { APPLY_PAGE_HEADERS, escapeHtml, renderApplyPage, renderNoticePage } from "./apply-page.js";
import { botSender, tryLockApply, type AnsweredEntry, type ApplySender } from "./apply-session.js";

const log = logger.child({ module: "apply-routes" });

const PREFIX = "/apply/";
const MAX_BODY_BYTES = 64 * 1024;
const FORM_TYPE = "application/x-www-form-urlencoded";
const NOT_FOUND = "Not found";

export interface ApplyRouteDeps {
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Snapshot directory root; defaults to the data root. */
  readonly root?: string;
  readonly record: (profileId: string, label: string, answer: string) => Promise<void>;
  readonly refill: typeof refillFromPage;
  readonly senderFor: (chatId: string) => ApplySender;
}

export function defaultApplyRouteDeps(): ApplyRouteDeps {
  return { now: Date.now, env: process.env, record: recordLearnedAnswer, refill: refillFromPage, senderFor: botSender };
}

/** True for `/apply/...` (query string ignored). `/applying` and `/apply` alone are not ours. */
export function isApplyPath(url: string | undefined): boolean {
  return (url ?? "").split("?")[0]?.startsWith(PREFIX) === true;
}

function tokenFromUrl(url: string | undefined): string {
  return (url ?? "").split("?")[0]?.slice(PREFIX.length) ?? "";
}

function text(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  text(res, 404, NOT_FOUND);
}

function html(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...APPLY_PAGE_HEADERS, ...extra });
  res.end(body);
}

function notice(res: ServerResponse, status: number, title: string, message: string, extra: Record<string, string> = {}): void {
  html(res, status, renderNoticePage(title, message), extra);
}

const TOO_LARGE = Symbol("too-large");

/** The whole body as text, or TOO_LARGE as soon as it passes the cap (the rest is dropped, not buffered). */
function readBody(req: IncomingMessage): Promise<string | typeof TOO_LARGE> {
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

type Resolved = { readonly ok: true; readonly snap: ApplySnapshot } | { readonly ok: false; readonly status: 404 | 410 };

/** Token to snapshot. Anything short of a genuine signature on a stored snapshot is a 404. */
function resolveRequest(req: IncomingMessage, deps: ApplyRouteDeps): Resolved {
  const cfg = readApplyLinkConfig(deps.env);
  if (!cfg.ok) {
    log.warn({ reason: cfg.reason }, "apply page requested but the link config is incomplete");
    return { ok: false, status: 404 };
  }
  const token = tokenFromUrl(req.url);
  const parsed = parseApplyToken(token);
  if (!parsed) return { ok: false, status: 404 };
  const snap = loadApplySnapshot(parsed.rowId, deps.root);
  if (!snap) return { ok: false, status: 404 };
  const verdict = verifyApplyToken(cfg.secret, token, snap.profileId, deps.now());
  if (!verdict.ok) return { ok: false, status: verdict.reason === "expired" ? 410 : 404 };
  return { ok: true, snap };
}

/** The re-fill runs after the response: the browser takes about a minute. Failures go to the chat. */
async function runRefill(snap: ApplySnapshot, posted: readonly AnsweredEntry[], held: () => void, deps: ApplyRouteDeps): Promise<void> {
  const send = deps.senderFor(snap.chatId);
  try {
    await deps.refill(snap, posted, held, send);
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ rowId: snap.rowId, err: reason }, "apply page re-fill rejected");
    try {
      await send.text(`⚠ Re-fill crashed for ${escapeHtml(snap.company)}: ${escapeHtml(reason)}`);
    } catch (sendErr) {
      log.error({ rowId: snap.rowId, err: (sendErr as Error).message }, "apply page re-fill: could not tell the chat");
    }
  } finally {
    held();
  }
}

async function handlePost(req: IncomingMessage, res: ServerResponse, snap: ApplySnapshot, deps: ApplyRouteDeps): Promise<void> {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith(FORM_TYPE)) {
    text(res, 415, "Unsupported content type");
    return;
  }
  const body = await readBody(req);
  if (body === TOO_LARGE) {
    text(res, 413, "Request too large", { Connection: "close" });
    return;
  }
  const collected = collectAnswers(snap, new URLSearchParams(body));
  if (!collected.ok) {
    notice(res, 400, "Could not save", collected.error);
    return;
  }
  const answers = collected.answers;
  if (answers.length === 0) {
    notice(res, 200, "Nothing to save", "Nothing new to save. Answer a question or change a value, then save again.");
    return;
  }
  const held = tryLockApply(snap.rowId, deps.now());
  if (!held) {
    notice(res, 409, "Already updating", "This form is already updating. Check Telegram for the new card, then reload this link.");
    return;
  }
  try {
    for (const a of answers) await deps.record(snap.profileId, a.label, a.answer);
  } catch (err) {
    held();
    log.error({ rowId: snap.rowId, err: (err as Error).message }, "apply page: saving answers failed");
    notice(res, 500, "Could not save", "Saving failed, so some answers may be missing. Try again in a minute.");
    return;
  }
  log.info({ rowId: snap.rowId, answers: answers.length }, "apply page: answers saved, re-fill started");
  void runRefill(snap, answers, held, deps);
  const n = answers.length;
  notice(
    res,
    200,
    "Saved",
    `Saved ${n} answer${n === 1 ? "" : "s"}. Re-filling the form — the updated card arrives in Telegram in about a minute.`,
  );
}

/** Entry point for every `/apply/...` request. Never throws; an unexpected error is a plain 500. */
export async function handleApplyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApplyRouteDeps = defaultApplyRouteDeps(),
): Promise<void> {
  try {
    const method = req.method ?? "";
    if (method !== "GET" && method !== "POST") {
      text(res, 405, "Method not allowed", { Allow: "GET, POST" });
      return;
    }
    const found = resolveRequest(req, deps);
    if (!found.ok) {
      if (found.status === 410) notice(res, 410, "Link expired", "This link has expired. Run /apply again in Telegram for a fresh one.");
      else notFound(res);
      return;
    }
    if (method === "GET") html(res, 200, renderApplyPage(found.snap));
    else await handlePost(req, res, found.snap, deps);
  } catch (err) {
    log.error({ err: (err as Error).message }, "apply page request failed");
    if (!res.headersSent) text(res, 500, "Something went wrong");
    else res.end();
  }
}
