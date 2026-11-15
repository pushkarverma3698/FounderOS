/**
 * Answer bank: GET /apply/questions (shell), GET /apply/api/questions (top 50 open questions),
 * POST /apply/api/questions (one answer). Auth is the saved-answers editor's: initData signed by the jobs bot
 * (miniapp-auth.ts), profile taken from the signature, anything else a plain 404. A save goes through
 * upsertLearnedAnswer (answer-store.ts) with the editor's base-version check, so the next shadow pass fills it.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { answerVersion, readAnswerState, upsertLearnedAnswer, type SaveResult } from "../tools/jobhunt/answer-store.js";
import { COMPANY_PLACEHOLDER, isSensitiveQuestion, summaryLine } from "../tools/jobhunt/open-questions.js";
import { getProfile } from "../tools/jobhunt/profile-config.js";
import { logger } from "../infra/logger.js";
import { readBody, TOO_LARGE } from "./apply-api.js";
import { authenticateMiniApp } from "./miniapp-auth.js";
import type { ProfileEditorDeps } from "./profile-api.js";
import { openQuestionsFor, type QuestionsDeps } from "./questions-data.js";
import { questionsHeaders, renderQuestionsPage } from "./questions-page.js";

const log = logger.child({ module: "questions-api" });
const SHELL_PATH = "/apply/questions";
const API_PATH = "/apply/api/questions";
export const MAX_SHOWN = 50;
const MAX_QUESTION_CHARS = 300;
const MAX_ANSWER_CHARS = 2000;

export interface QuestionsApiDeps extends ProfileEditorDeps {
  readonly data?: QuestionsDeps;
}

export function isQuestionsPath(url: string | undefined): boolean {
  const p = (url ?? "").split("?")[0]?.replace(/\/+$/, "");
  return p === SHELL_PATH || p === API_PATH;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

/** The page data. Holds question wordings and counts only, never a saved answer. */
export async function buildQuestionsState(profileId: string, now: Date, data?: QuestionsDeps): Promise<Readonly<Record<string, unknown>>> {
  const [open, read] = await Promise.all([openQuestionsFor(profileId, now, data), readAnswerState(profileId)]);
  const shown = open.questions.slice(0, MAX_SHOWN);
  return {
    candidateName: getProfile(profileId).candidateName,
    summary: summaryLine(open),
    version: read.state ? answerVersion(read.state) : "broken",
    questions: shown.map((q) => ({ label: q.label, roles: q.roles, template: q.template })),
    more: open.questions.length - shown.length,
    profileFields: open.profileFields.map((q) => ({ label: q.label, roles: q.roles })),
  };
}

async function post(req: IncomingMessage, res: ServerResponse, profileId: string, deps: QuestionsApiDeps): Promise<void> {
  const raw = await readBody(req);
  if (raw === TOO_LARGE) return json(res, 413, { error: "request too large" });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // allow-failopen: an unreadable body is reported as a 400, which refuses the save.
    return json(res, 400, { error: "the request was not valid JSON" });
  }
  const base = typeof body["baseVersion"] === "string" ? body["baseVersion"] : "";
  const question = typeof body["question"] === "string" ? body["question"].trim() : "";
  const answer = typeof body["answer"] === "string" ? body["answer"].trim() : "";
  if (!base) return json(res, 400, { error: "baseVersion is required: reload the page" });
  if (!question || question.length > MAX_QUESTION_CHARS) return json(res, 400, { error: `a question is needed (up to ${MAX_QUESTION_CHARS} characters)` });
  if (question.includes(COMPANY_PLACEHOLDER)) return json(res, 400, { error: "that question names the company, so it is answered on each form and not saved" });
  if (isSensitiveQuestion(question)) return json(res, 400, { error: "work-authorisation, visa and diversity questions are answered in /profile, not here" });
  if (!answer || answer.length > MAX_ANSWER_CHARS) return json(res, 400, { error: `an answer is needed (up to ${MAX_ANSWER_CHARS} characters)` });
  let saved: SaveResult;
  try {
    saved = await upsertLearnedAnswer(profileId, question, answer, { precondition: (s) => answerVersion(s) === base });
  } catch (err) {
    log.error({ profileId, err: (err as Error).message }, "questions: save crashed");
    return json(res, 500, { error: "Saving failed, nothing was changed. Try again." });
  }
  const state = async () => buildQuestionsState(profileId, new Date(deps.now()), deps.data);
  if (!saved.ok) {
    if (saved.stale) return json(res, 409, { error: "Your answers changed since this page loaded. The latest is shown; redo the save.", stale: true, state: await state() });
    return json(res, 400, { error: saved.reason });
  }
  log.info({ profileId, changed: saved.changed }, "questions: saved");
  json(res, 200, { ok: true, changed: saved.changed, state: await state() });
}

export async function handleQuestions(req: IncomingMessage, res: ServerResponse, deps: QuestionsApiDeps): Promise<void> {
  const path = (req.url ?? "").split("?")[0]?.replace(/\/+$/, "");
  const method = req.method ?? "";
  if (path === SHELL_PATH) {
    if (method !== "GET") return void res.writeHead(405, { Allow: "GET" }).end();
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, questionsHeaders(nonce));
    res.end(renderQuestionsPage(nonce));
    return;
  }
  if (method !== "GET" && method !== "POST") return void res.writeHead(405, { Allow: "GET, POST" }).end();
  const header = req.headers["x-telegram-init-data"];
  const who = authenticateMiniApp(Array.isArray(header) ? header[0] : header, deps.env, deps.now());
  if (!who.ok) return json(res, 404, { error: "not found" });
  if (method === "GET") return json(res, 200, await buildQuestionsState(who.profileId, new Date(deps.now()), deps.data));
  await post(req, res, who.profileId, deps);
}
