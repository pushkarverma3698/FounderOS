/**
 * Apply answer page: HTML renderer
 * ================================
 * Pure functions: a snapshot goes in, a mobile-first HTML string comes out. No script, no external
 * resource, one inline style block whose hash is pinned in the Content-Security-Policy. Every string
 * from the snapshot (labels, options, company names) came from a third-party site, so every one is
 * escaped. The page never submits an application; it saves answers and asks the bot to re-fill.
 */

import { createHash } from "node:crypto";
import type { ApplySnapshot, ApplySnapshotQuestion } from "../tools/jobhunt/apply-link.js";

const MAX_RADIO_OPTIONS = 4;
export const MAX_ANSWER_CHARS = 2000;
export const READ_ONLY_FIELD_TYPES: ReadonlySet<string> = new Set(["file", "captcha"]);

const CSS =
  "body{margin:0;background:#f6f7f9;color:#14181f;font:16px/1.45 system-ui,-apple-system,sans-serif}" +
  "main{max-width:640px;margin:0 auto;padding:16px}h1{font-size:1.25rem;margin:0 0 4px}" +
  "h2{font-size:1.05rem;margin:24px 0 8px}.sub{color:#5b6573;margin:0 0 12px}" +
  ".q{background:#fff;border:1px solid #dde1e7;border-radius:10px;padding:12px;margin:0 0 12px}" +
  ".q .t{display:block;font-weight:600;margin-bottom:6px}.req{color:#b42318;font-size:.8rem;margin-left:6px}" +
  ".opt{color:#5b6573;font-size:.8rem;margin-left:6px}" +
  "input[type=text],select,textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #b9c0cb;border-radius:8px;background:#fff;color:inherit}" +
  ".choice{display:block;padding:8px 0}.choice input{margin-right:8px}" +
  "button{width:100%;font:inherit;font-weight:600;padding:14px;border:0;border-radius:10px;background:#1f6feb;color:#fff;margin-top:8px}" +
  ".hint,.note{color:#5b6573;font-size:.9rem;margin:6px 0 0}.warn{background:#fff4e5;border:1px solid #f0c36d;border-radius:10px;padding:10px}" +
  "ul{padding-left:20px;margin:0}li{margin:2px 0}.foot{color:#5b6573;font-size:.85rem;margin-top:24px}" +
  "@media(prefers-color-scheme:dark){body{background:#0f1319;color:#e6e9ee}.q{background:#171c24;border-color:#2a313c}" +
  "input[type=text],select,textarea{background:#0f1319;border-color:#3a4350}" +
  ".sub,.hint,.note,.foot,.opt{color:#9aa4b2}.warn{background:#2b2211;border-color:#6b5320}}";

const STYLE_HASH = createHash("sha256").update(CSS).digest("base64");

/** Sent with every page. The style hash is the only allowance; nothing can load or run anything else. */
export const APPLY_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
};

/**
 * Form field name for a question. Hashed, not positional: a page left open while the form changes
 * can never map an answer onto a different question, and no label text appears in a field name.
 */
export function applyFieldName(label: string): string {
  return `q_${createHash("sha256").update(label).digest("hex").slice(0, 16)}`;
}

const HTML_ESCAPES: Readonly<Record<number, string>> = {
  38: "&amp;",
  60: "&lt;",
  62: "&gt;",
  34: "&quot;",
  39: "&#39;",
};

/** Escapes text for element content and double- or single-quoted attributes. */
export function escapeHtml(text: string): string {
  let out = "";
  for (const ch of text) out += HTML_ESCAPES[ch.charCodeAt(0)] ?? ch;
  return out;
}

/** Result pages (saved, busy, nothing new): same shell, one escaped message. */
export function renderNoticePage(title: string, message: string): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

const DOCTYPE = `<!doctype html>`;
const HEAD_META = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">`;

function shell(title: string, inner: string): string {
  const head = HEAD_META + `<title>${escapeHtml(title)}</title><style>${CSS}</style>`;
  return DOCTYPE + `<html lang="en"><head>${head}</head><body><main>${inner}</main></body></html>`;
}

function option(o: string): string {
  return `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`;
}

function choice(name: string, o: string): string {
  const v = escapeHtml(o);
  return `<label class="choice"><input type="radio" name="${name}" value="${v}"> ${v}</label>`;
}

function renderControl(q: ApplySnapshotQuestion, name: string): string {
  const options = q.options ?? [];
  if (options.length > 0 && options.length <= MAX_RADIO_OPTIONS) {
    return options.map((o) => choice(name, o)).join("");
  }
  if (options.length > 0) {
    return `<select name="${name}" id="${name}"><option value="">Choose</option>${options.map(option).join("")}</select>`;
  }
  if (q.fieldType === "textarea") {
    return `<textarea name="${name}" id="${name}" rows="5" maxlength="${MAX_ANSWER_CHARS}"></textarea>`;
  }
  return `<input type="text" name="${name}" id="${name}" maxlength="${MAX_ANSWER_CHARS}" autocomplete="off">`;
}

function hintFor(q: ApplySnapshotQuestion): string {
  if (!q.triedAnswer) return "";
  const pick = q.options && q.options.length > 0 ? " or pick an option" : "";
  return `<p class="hint">The bot could not fill your last answer (${escapeHtml(q.triedAnswer)}). Try other wording${pick}.</p>`;
}

function flagFor(q: ApplySnapshotQuestion): string {
  return q.required ? `<span class="req">required</span>` : `<span class="opt">optional</span>`;
}

function renderQuestion(q: ApplySnapshotQuestion): string {
  const title = `${escapeHtml(q.label)}${flagFor(q)}`;
  if (READ_ONLY_FIELD_TYPES.has(q.fieldType)) {
    const what = q.fieldType === "file" ? "file upload" : "CAPTCHA";
    return `<div class="q"><div class="t">${title}</div><p class="note">This ${what} cannot be answered here.</p></div>`;
  }
  const name = applyFieldName(q.label);
  const radios = q.options !== undefined && q.options.length > 0 && q.options.length <= MAX_RADIO_OPTIONS;
  const head = radios ? `<div class="t">${title}</div>` : `<label class="t" for="${name}">${title}</label>`;
  return `<div class="q">${head}${renderControl(q, name)}${hintFor(q)}</div>`;
}

/** Required questions first; the order inside each group is the form's own order. */
function orderQuestions(qs: readonly ApplySnapshotQuestion[]): ApplySnapshotQuestion[] {
  return [...qs].sort((a, b) => Number(b.required) - Number(a.required));
}

function renderFilled(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  return `<h2>Already filled (${labels.length})</h2><ul>${labels.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
}

function renderQuestions(qs: readonly ApplySnapshotQuestion[]): string {
  if (qs.length === 0) {
    return `<h2>Nothing left to answer</h2><p class="note">Every question has an answer. Review the form below, then press Submit in Telegram.</p>`;
  }
  const editable = qs.some((q) => !READ_ONLY_FIELD_TYPES.has(q.fieldType));
  const button = editable ? `<button type="submit">Save answers and re-fill</button>` : "";
  return `<form method="post"><h2>Needs your answer (${qs.length})</h2>${qs.map(renderQuestion).join("")}${button}</form>`;
}

const FOOTER =
  `<p class="foot">This page never submits the application. After you save, the bot re-fills the form ` +
  `and sends the updated card to Telegram, where you press Submit.</p>`;

/** The answer page for one snapshot. */
export function renderApplyPage(snap: ApplySnapshot): string {
  const s = snap.summary;
  const title = `${snap.company}: ${snap.title}`;
  const intro = `${snap.platform} application for ${snap.candidateName}. ${s.filled} of ${s.total} fields filled.`;
  const warn = s.hasCaptcha
    ? `<p class="warn">This form has a CAPTCHA the bot cannot solve, so it may not be submittable from Telegram.</p>`
    : "";
  const body = `<h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(intro)}</p>${warn}`;
  return shell(title, body + renderQuestions(orderQuestions(s.unanswered)) + renderFilled(s.filledLabels) + FOOTER);
}
