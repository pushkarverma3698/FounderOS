/**
 * Hand-off panel: HTTP routes
 * ===========================
 * Under the answer-page link, for a role the bot must not (or cannot) fill:
 *
 *   GET  /apply/<token>/handoff            the shell (no personal data); the link signature is its only proof
 *   GET  /apply/<token>/handoff/panel      the rows, as an HTML fragment
 *   GET  /apply/<token>/handoff/file/cv|letter   the tailored CV or cover-letter PDF
 *   POST /apply/<token>/handoff/applied    marks the role applied (the digest's "I applied" write)
 *
 * Everything past the shell needs both proofs the Mini App API needs (ADR-018, amendment 2026-10-18): the HMAC
 * link and Telegram initData for the profile that owns the row. Any failure is the plain 404 the page uses. The
 * panel is read-only: it never submits to an employer and never saves an answer. "I applied" is the only write,
 * and it is the founder's own statement that he applied.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getApplicationById } from "../db/apply-queries.js";
import type { JobApplication } from "../db/schema.js";
import { logger } from "../infra/logger.js";
import { loadApplySnapshot, parseApplyToken, readApplyLinkConfig, verifyApplyToken, type ApplySnapshot } from "../tools/jobhunt/apply-link.js";
import { applyProfilePathFor, readApplyProfile, type ApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { readCandidateDossier, type CandidateDossier } from "../tools/jobhunt/candidate-dossier.js";
import { buildHandoffRows, isWorkdayUrl } from "../tools/jobhunt/handoff-rows.js";
import { getProfile } from "../tools/jobhunt/profile-config.js";
import { authorize, type ApiDeps, type OkAuth } from "./apply-api.js";
import { renderHandoffPanel, renderHandoffShell, type HandoffModel } from "./apply-handoff-page.js";
import { APPLY_PAGE_HEADERS, applyPageHeaders, renderNoticePage } from "./apply-page.js";
import { markRowApplied } from "./jobhunt-buttons.js";

const log = logger.child({ module: "apply-handoff" });

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const NOT_FOUND = "This form is closed: it was sent, cancelled, or the link is wrong. Run /apply again in Telegram for a fresh one.";
const NO_PROFILE = "No usable apply profile is on file, so there are no answers to copy. Send /profile in Telegram first.";

/** The I/O the panel does, replaceable in tests. Each defaults to the real one. */
export interface HandoffDeps {
  readonly readProfile?: (profileId: string) => Promise<ApplyProfile | null>;
  readonly readDossier?: (profileId: string) => Promise<CandidateDossier | null>;
  readonly loadRow?: (rowId: string, profileId: string) => Promise<JobApplication | null>;
  readonly markApplied?: typeof markRowApplied;
}

export type HandoffRouteDeps = ApiDeps & { readonly handoff?: HandoffDeps };

async function defaultReadProfile(profileId: string): Promise<ApplyProfile | null> {
  const loaded = await readApplyProfile(applyProfilePathFor(profileId));
  return loaded.ok ? loaded.profile : null;
}

const defaultLoadRow = (rowId: string, profileId: string): Promise<JobApplication | null> => getApplicationById(rowId, getProfile(profileId).tenantId);

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer): void {
  res.writeHead(status, headers);
  res.end(body);
}

function notFound(res: ServerResponse): void {
  send(res, 404, APPLY_PAGE_HEADERS as Record<string, string>, renderNoticePage("Link closed", NOT_FOUND));
}

const json = (res: ServerResponse, status: number, body: unknown): void =>
  send(res, status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, JSON.stringify(body));

/** The link signature alone, for the shell. A snapshot must exist; an expired link is 410, only for a genuine signature. */
function linkSnapshot(token: string, deps: ApiDeps): { readonly snap: ApplySnapshot } | { readonly status: 404 | 410 } {
  const cfg = readApplyLinkConfig(deps.env);
  const parsed = parseApplyToken(token);
  if (!cfg.ok || !parsed) return { status: 404 };
  const snap = loadApplySnapshot(parsed.rowId, deps.root);
  if (!snap) return { status: 404 };
  const verdict = verifyApplyToken(cfg.secret, token, snap.profileId, deps.now());
  return verdict.ok ? { snap } : { status: verdict.reason === "expired" ? 410 : 404 };
}

async function pdfExists(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_PDF_BYTES;
  } catch {
    // allow-failopen: a missing file just means no download link for it.
    return false;
  }
}

async function panelModel(snap: ApplySnapshot, deps: HandoffRouteDeps): Promise<HandoffModel> {
  const io = deps.handoff ?? {};
  const profile = await (io.readProfile ?? defaultReadProfile)(snap.profileId);
  const dossier = profile ? await (io.readDossier ?? readCandidateDossier)(snap.profileId) : null;
  const rows = profile
    ? buildHandoffRows(profile, dossier, snap.summary.formFields, {
        company: snap.company, title: snap.title, url: snap.targetUrl, ...(snap.coverLetter ? { coverLetterText: snap.coverLetter.text } : {}),
      })
    : [];
  return {
    company: snap.company,
    title: snap.title,
    jobUrl: snap.targetUrl,
    rows,
    ...(snap.handoffReason ? { reason: snap.handoffReason } : snap.summary.hasCaptcha ? { reason: "This form has a bot check the bot must not pass, so you finish it by hand." } : {}),
    ...(profile && isWorkdayUrl(snap.targetUrl) && profile.email ? { workdayEmail: profile.email } : {}),
    hasCv: await pdfExists(snap.resumePath),
    hasLetterPdf: snap.coverLetter ? await pdfExists(snap.coverLetter.pdfPath) : false,
    ...(profile ? {} : { warning: NO_PROFILE }),
  };
}

async function sendFile(res: ServerResponse, snap: ApplySnapshot, kind: string): Promise<void> {
  const file = kind === "cv" ? snap.resumePath : kind === "letter" ? snap.coverLetter?.pdfPath : undefined;
  if (!file || !(await pdfExists(file))) return json(res, 404, { error: "not found" });
  const name = path.basename(file).replace(/[^A-Za-z0-9._-]/g, "_");
  send(res, 200, {
    "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  }, await fs.readFile(file));
}

async function applied(res: ServerResponse, a: OkAuth, deps: HandoffRouteDeps): Promise<void> {
  const io = deps.handoff ?? {};
  const row = await (io.loadRow ?? defaultLoadRow)(a.rowId, a.profileId);
  if (!row) return json(res, 404, { error: "not found" });
  const result = await (io.markApplied ?? markRowApplied)(row);
  if (!result.ok) return json(res, 500, { error: "The row could not be marked applied." });
  log.info({ rowId: a.rowId, already: result.already }, "hand-off: marked applied by the candidate");
  json(res, 200, { state: "applied", already: result.already });
}

/** `rest` is what follows `/handoff` in the path. Never throws past the caller's catch; every refusal is a 404 or 405. */
export async function handleHandoff(req: IncomingMessage, res: ServerResponse, token: string, rest: readonly string[], deps: HandoffRouteDeps): Promise<void> {
  const method = req.method ?? "";
  const [sub, arg, ...extra] = rest;
  if (extra.length > 0 || (sub === undefined && arg !== undefined)) return notFound(res);
  const want = sub === "applied" ? "POST" : sub === undefined || sub === "panel" || sub === "file" ? "GET" : null;
  if (!want) return notFound(res);
  if (method !== want) {
    res.setHeader("Allow", want);
    return json(res, 405, { error: "method not allowed" });
  }
  if (sub === undefined) {
    const found = linkSnapshot(token, deps);
    if ("status" in found) {
      const message = found.status === 410 ? "This link has expired. Run /apply again in Telegram for a fresh one." : NOT_FOUND;
      return send(res, found.status, APPLY_PAGE_HEADERS as Record<string, string>, renderNoticePage(found.status === 410 ? "Link expired" : "Link closed", message));
    }
    const nonce = randomBytes(16).toString("base64");
    return send(res, 200, { ...applyPageHeaders(nonce) }, renderHandoffShell(found.snap, nonce));
  }
  const a = authorize(req, token, deps);
  if (!a.ok || !a.snap) return notFound(res);
  if (sub === "applied") return applied(res, a, deps);
  if (sub === "file") return sendFile(res, a.snap, arg ?? "");
  if (arg !== undefined) return notFound(res);
  const body = renderHandoffPanel(await panelModel(a.snap, deps));
  send(res, 200, { ...APPLY_PAGE_HEADERS }, body);
}
