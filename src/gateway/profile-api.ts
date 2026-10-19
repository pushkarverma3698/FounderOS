/**
 * Saved-answers editor: routes and API
 * ====================================
 *   GET  /apply/profile        a static shell page (initData lives in the URL fragment, so the server cannot
 *                              know who is asking); its script loads the data below.
 *   GET  /apply/api/profile    the signed-in profile's answers as JSON.
 *   POST /apply/api/profile    one edit: setCore | upsertLearned | deleteLearned | restore.
 *
 * Every API call needs initData signed by the jobs bot (miniapp-auth.ts); the profile is whoever the signed
 * Telegram user maps to, never a value the request names. Anything unauthenticated is a plain 404.
 * Every edit goes through answer-store.ts (backup, validation, Core Facts in step, atomic write). Each edit
 * carries the `version` the page loaded; if the answers changed since (a /profile set, a learned answer
 * recorded mid-apply) the store refuses under its lock and the reply is 409 with the latest state.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WORK_AUTHORIZATION } from "../tools/jobhunt/apply-profile.js";
import {
  answerVersion,
  deleteLearnedAnswer,
  listAnswerBackups,
  listLearnedAnswers,
  readAnswerState,
  restoreAnswerBackup,
  saveAnswers,
  setCoreAnswer,
  upsertLearnedAnswer,
  type AnswerState,
  type SaveResult,
} from "../tools/jobhunt/answer-store.js";
import { getProfile } from "../tools/jobhunt/profile-config.js";
import type { SelfIdCategory } from "../tools/jobhunt/self-identification.js";
import { logger } from "../infra/logger.js";
import { readBody, TOO_LARGE } from "./apply-api.js";
import { authenticateMiniApp } from "./miniapp-auth.js";
import { coreFactsOf } from "./profile-facts.js";
import { profileHeaders, renderProfilePage } from "./profile-page.js";

const log = logger.child({ module: "profile-api" });

const SHELL_PATH = "/apply/profile";
const API_PATH = "/apply/api/profile";
const MAX_QUESTION_CHARS = 300;
const MAX_ANSWER_CHARS = 2000;
const MAX_VALUE_CHARS = 500;
const EEO_PREFIX = "self_identification.";

type Kind = "select" | "text" | "number";
interface CoreSpec {
  readonly field: string;
  readonly label: string;
  readonly kind: Kind;
  readonly options?: readonly string[];
}
const BOOL = ["true", "false"] as const;
const CORE: readonly CoreSpec[] = [
  { field: "work_authorization", label: "Right to work", kind: "select", options: WORK_AUTHORIZATION },
  { field: "work_authorization_detail", label: "Right to work: detail", kind: "text" },
  { field: "salary_floor_eur_year", label: "Salary expectation (EUR per year)", kind: "number" },
  { field: "salary_floor_basis", label: "Salary basis", kind: "text" },
  { field: "notice_period_days", label: "Notice period (days)", kind: "number" },
  { field: "notice_period_detail", label: "Notice period: detail", kind: "text" },
  { field: "willing_to_relocate", label: "Willing to relocate", kind: "select", options: BOOL },
  { field: "needs_relocation", label: "Needs relocation support", kind: "select", options: BOOL },
];
const EEO: ReadonlyArray<readonly [SelfIdCategory, string]> = [
  ["gender", "Gender"],
  ["hispanic_latino", "Hispanic or Latino"],
  ["race", "Race or ethnicity"],
  ["veteran", "Veteran status"],
  ["disability", "Disability"],
  ["sexual_orientation", "Sexual orientation"],
];

export interface ProfileEditorDeps {
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

type Obj = Readonly<Record<string, unknown>>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const show = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/** `/apply/profile` or `/apply/api/profile`, query ignored. */
export function isProfileEditorPath(url: string | undefined): boolean {
  const p = (url ?? "").split("?")[0]?.replace(/\/+$/, "");
  return p === SHELL_PATH || p === API_PATH;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}
const notFound = (res: ServerResponse): void => json(res, 404, { error: "not found" });

/** The answers page data for one profile: current values, their allowed values, learned Q&A, Core Facts, backups. */
export async function buildEditorState(profileId: string): Promise<Obj> {
  const base = { profileId, candidateName: getProfile(profileId).candidateName };
  const read = await readAnswerState(profileId);
  const backups = (await listAnswerBackups(profileId)).map((b) => ({ id: b.ts, profile: b.json, dossier: b.md }));
  if (!read.state) return { ...base, broken: read.reason ?? "unreadable", version: "broken", core: [], eeo: [], learned: [], coreFacts: [], backups };
  const answers = obj(read.state.profile["answers"]);
  const selfId = obj(answers["self_identification"]);
  return {
    ...base,
    version: answerVersion(read.state),
    core: CORE.map((c) => ({ field: c.field, label: c.label, kind: c.kind, value: show(answers[c.field]), ...(c.options ? { options: c.options } : {}) })),
    eeo: EEO.map(([cat, label]) => ({ field: EEO_PREFIX + cat, label, value: show(selfId[cat]) })),
    learned: await listLearnedAnswers(profileId),
    coreFacts: coreFactsOf(read.state.dossierMarkdown),
    backups,
  };
}

type Body = Obj;
interface Planned {
  readonly run: (profileId: string, base: string) => Promise<SaveResult>;
  readonly summary: (changed: boolean) => string;
}
type Plan = Planned | { readonly error: string };

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" && v.trim().length <= max ? v.trim() : null);
const stillAt = (base: string) => (s: AnswerState): boolean => answerVersion(s) === base;

function planSetCore(b: Body): Plan {
  const field = typeof b["field"] === "string" ? b["field"] : "";
  const value = typeof b["value"] === "string" ? b["value"].trim() : "";
  if (value.length > MAX_VALUE_CHARS) return { error: `keep it under ${MAX_VALUE_CHARS} characters` };
  if (field.startsWith(EEO_PREFIX)) {
    const cat = field.slice(EEO_PREFIX.length);
    const spec = EEO.find(([c]) => c === cat);
    if (!spec) return { error: `${field} is not a field you can edit here` };
    return {
      summary: (changed) => (changed ? `${spec[1]}: ${value || "cleared (the form's decline option is used)"}` : `${spec[1]} was already that`),
      run: (id, base) =>
        saveAnswers(
          id,
          (s) => {
            const answers = { ...obj(s.profile["answers"]) };
            const sid = { ...obj(answers["self_identification"]) } as Record<string, unknown>;
            if (value) sid[cat] = value;
            else delete sid[cat];
            if (JSON.stringify(sid) === JSON.stringify(obj(answers["self_identification"]))) return null;
            return { profile: { ...s.profile, answers: { ...answers, self_identification: sid } }, dossierMarkdown: s.dossierMarkdown };
          },
          { precondition: stillAt(base) },
        ),
    };
  }
  const spec = CORE.find((c) => c.field === field);
  if (!spec) return { error: `${field || "that"} is not a field you can edit here` };
  if (value === "") return { error: `${spec.label} needs a value` };
  if (spec.options && !spec.options.includes(value)) return { error: `${spec.label} must be one of: ${spec.options.join(", ")}` };
  if (spec.kind === "number" && !/^\d+(\.\d+)?$/.test(value)) return { error: `${spec.label} must be a number, like 65000` };
  return {
    summary: (changed) => (changed ? `${spec.label}: ${value}` : `${spec.label} was already ${value}`),
    run: (id, base) => setCoreAnswer(id, field, value, { precondition: stillAt(base) }),
  };
}

function plan(b: Body): Plan {
  switch (b["op"]) {
    case "setCore":
      return planSetCore(b);
    case "upsertLearned": {
      const question = text(b["question"], MAX_QUESTION_CHARS);
      const answer = text(b["answer"], MAX_ANSWER_CHARS);
      if (!question) return { error: `a question is needed (up to ${MAX_QUESTION_CHARS} characters)` };
      if (!answer) return { error: `an answer is needed (up to ${MAX_ANSWER_CHARS} characters)` };
      return {
        summary: () => `Saved the answer to "${question}"`,
        run: (id, base) => upsertLearnedAnswer(id, question, answer, { precondition: stillAt(base) }),
      };
    }
    case "deleteLearned": {
      const question = text(b["question"], MAX_QUESTION_CHARS);
      if (!question) return { error: "a question is needed" };
      return {
        summary: (changed) => (changed ? `Deleted the answer to "${question}"` : `There was no saved answer to "${question}"`),
        run: (id, base) => deleteLearnedAnswer(id, question, { precondition: stillAt(base) }),
      };
    }
    case "restore": {
      const backupId = typeof b["backupId"] === "string" ? b["backupId"] : "";
      if (!backupId) return { error: "choose a backup to restore" };
      return {
        summary: () => `Restored the answers from the backup of ${backupId}`,
        run: async (id, base) => {
          const r = await restoreAnswerBackup(id, backupId, (s) => (s ? answerVersion(s) : "broken") === base);
          return r.ok ? { ok: true, changed: true } : r;
        },
      };
    }
    default:
      return { error: "unknown edit" };
  }
}

async function post(req: IncomingMessage, res: ServerResponse, profileId: string): Promise<void> {
  const raw = await readBody(req);
  if (raw === TOO_LARGE) return json(res, 413, { error: "request too large" });
  let body: Body;
  try {
    body = obj(JSON.parse(raw));
  } catch {
    // allow-failopen: an unreadable body is reported as a 400, which refuses the edit.
    return json(res, 400, { error: "the request was not valid JSON" });
  }
  const base = typeof body["baseVersion"] === "string" ? body["baseVersion"] : "";
  if (!base) return json(res, 400, { error: "baseVersion is required: reload the page" });
  const planned = plan(body);
  if ("error" in planned) return json(res, 400, { error: planned.error });
  let saved: SaveResult;
  try {
    saved = await planned.run(profileId, base);
  } catch (err) {
    log.error({ profileId, err: (err as Error).message }, "profile editor: save crashed");
    return json(res, 500, { error: "Saving failed, nothing was changed. Try again." });
  }
  if (!saved.ok) {
    if (saved.stale) return json(res, 409, { error: "Your answers changed since this page loaded. The latest is shown; redo the edit.", stale: true, state: await buildEditorState(profileId) });
    return json(res, 400, { error: saved.reason });
  }
  log.info({ profileId, op: body["op"], changed: saved.changed }, "profile editor: saved");
  json(res, 200, { ok: true, changed: saved.changed, summary: planned.summary(saved.changed), state: await buildEditorState(profileId) });
}

/** Entry point for the two editor paths. The caller has already checked isProfileEditorPath. */
export async function handleProfileEditor(req: IncomingMessage, res: ServerResponse, deps: ProfileEditorDeps): Promise<void> {
  const path = (req.url ?? "").split("?")[0]?.replace(/\/+$/, "");
  const method = req.method ?? "";
  if (path === SHELL_PATH) {
    if (method !== "GET") return void res.writeHead(405, { Allow: "GET" }).end();
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, profileHeaders(nonce));
    res.end(renderProfilePage(nonce));
    return;
  }
  if (method !== "GET" && method !== "POST") return void res.writeHead(405, { Allow: "GET, POST" }).end();
  const header = req.headers["x-telegram-init-data"];
  const who = authenticateMiniApp(Array.isArray(header) ? header[0] : header, deps.env, deps.now());
  if (!who.ok) {
    log.warn({ reason: who.reason }, "profile editor: initData refused");
    return notFound(res);
  }
  if (method === "GET") return json(res, 200, await buildEditorState(who.profileId));
  await post(req, res, who.profileId);
}
