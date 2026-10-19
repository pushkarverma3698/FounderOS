/**
 * Apply answer page: HTML renderer
 * ================================
 * Pure functions: a snapshot goes in, a mobile-first HTML string comes out. One inline style block whose
 * hash is pinned in the Content-Security-Policy. Without a nonce the page has no script and no external
 * resource. With one (the route passes it for the page itself) it adds Telegram's WebApp script and the one
 * nonce'd inline script (apply-page-script.ts) that drives Submit, Cancel and status inside Telegram.
 * Every string from the snapshot (labels, values, options, company names) came from a third-party site or
 * the candidate's profile, so every one is escaped. Saving answers asks the bot to re-fill.
 *
 * One form holds both sections: the questions the bot could not answer, and every field it did fill,
 * each with its value in an editable input. Files, consent boxes and anything the stored one-line
 * answer cannot represent are shown as text. A posted field the founder did not change is ignored.
 */

import { createHash } from "node:crypto";
import { APPLY_PAGE_SCRIPT } from "./apply-page-script.js";
import type { ApplySnapshot, ApplySnapshotFilled, ApplySnapshotQuestion } from "../tools/jobhunt/apply-link.js";
import { MAX_ANSWER_CHARS } from "../tools/jobhunt/form-filled.js";

const MAX_RADIO_OPTIONS = 4;
const SHOWN_VALUE_CHARS = 300;
const RESUME_LABEL = /r[eé]sum[eé]|\bcv\b/i;
export { MAX_ANSWER_CHARS };
export const READ_ONLY_FIELD_TYPES: ReadonlySet<string> = new Set(["file", "captcha"]);

type Summary = ApplySnapshot["summary"];
/** What a control needs to know about its field: a question and a filled answer both fit. */
interface ControlSpec {
  readonly fieldType: string;
  readonly options?: readonly string[];
}

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
  ".val{white-space:pre-wrap;overflow-wrap:anywhere}button.alt{background:transparent;color:inherit;border:1px solid #b9c0cb}" +
  "#mini{background:#fff;border:1px solid #dde1e7;border-radius:10px;padding:12px;margin:0 0 12px}" +
  "ul{padding-left:20px;margin:0}li{margin:2px 0}.foot{color:#5b6573;font-size:.85rem;margin-top:24px}" +
  "@media(prefers-color-scheme:dark){body{background:#0f1319;color:#e6e9ee}.q{background:#171c24;border-color:#2a313c}" +
  "input[type=text],select,textarea{background:#0f1319;border-color:#3a4350}#mini{background:#171c24;border-color:#2a313c}" +
  ".sub,.hint,.note,.foot,.opt{color:#9aa4b2}.warn{background:#2b2211;border-color:#6b5320}}";

const STYLE_HASH = createHash("sha256").update(CSS).digest("base64");

const TELEGRAM_SCRIPT_HOST = "https://telegram.org";

/**
 * Sent with every page. The style hash is the only style allowance. With a nonce the page may also run its one
 * inline script and load Telegram's WebApp script, and fetch its own origin; nothing else can load or run.
 * Only Telegram Web may frame the page: it opens the card's Mini App button in an iframe (native apps use a WebView).
 */
export function applyPageHeaders(nonce?: string): Readonly<Record<string, string>> {
  const script = nonce ? `script-src 'nonce-${nonce}' ${TELEGRAM_SCRIPT_HOST}; connect-src 'self'; ` : "";
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; ${script}form-action 'self'; frame-ancestors https://web.telegram.org; base-uri 'none'`,
  };
}

export const APPLY_PAGE_HEADERS: Readonly<Record<string, string>> = applyPageHeaders();

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

function shell(title: string, inner: string, mainAttrs = "", scripts = ""): string {
  const head = HEAD_META + `<title>${escapeHtml(title)}</title><style>${CSS}</style>`;
  return DOCTYPE + `<html lang="en"><head>${head}</head><body><main${mainAttrs}>${inner}</main>${scripts}</body></html>`;
}

/** A question the page offers an input for (a file or CAPTCHA cannot be answered here). */
export function isEditableQuestion(q: ApplySnapshotQuestion): boolean {
  return !READ_ONLY_FIELD_TYPES.has(q.fieldType);
}

/** A filled value the page offers an input for: flagged editable when the snapshot was made, and never a file. */
function isEditableFilled(f: ApplySnapshotFilled): boolean {
  return f.editable && !READ_ONLY_FIELD_TYPES.has(f.fieldType);
}

/**
 * The filled values the page offers inputs for: the first per field name, and never one an open
 * question already owns (a name must map to exactly one thing). `collectAnswers` reads the same list.
 */
export function editableFilled(s: Summary): ApplySnapshotFilled[] {
  const taken = new Set(s.unanswered.filter(isEditableQuestion).map((q) => applyFieldName(q.label)));
  const out: ApplySnapshotFilled[] = [];
  for (const f of s.filledAnswers) {
    const name = applyFieldName(f.label);
    if (!isEditableFilled(f) || taken.has(name)) continue;
    taken.add(name);
    out.push(f);
  }
  return out;
}

function option(o: string, selected: boolean): string {
  return `<option value="${escapeHtml(o)}"${selected ? " selected" : ""}>${escapeHtml(o)}</option>`;
}

function choice(name: string, o: string, checked: boolean): string {
  const v = escapeHtml(o);
  return `<label class="choice"><input type="radio" name="${name}" value="${v}"${checked ? " checked" : ""}> ${v}</label>`;
}

const usesRadios = (spec: ControlSpec): boolean =>
  spec.options !== undefined && spec.options.length > 0 && spec.options.length <= MAX_RADIO_OPTIONS;

/** The input for a field. `current` is what is already in it: empty for an open question. */
function renderControl(spec: ControlSpec, name: string, current: string): string {
  const options = spec.options ?? [];
  if (usesRadios(spec)) return options.map((o) => choice(name, o, o === current)).join("");
  if (options.length > 0) {
    // A select with no blank entry would post its first option for a value the form does not offer.
    const blank = options.includes(current) ? "" : `<option value="">Choose</option>`;
    return `<select name="${name}" id="${name}">${blank}${options.map((o) => option(o, o === current)).join("")}</select>`;
  }
  if (spec.fieldType === "textarea") {
    return `<textarea name="${name}" id="${name}" rows="5" maxlength="${MAX_ANSWER_CHARS}">${escapeHtml(current)}</textarea>`;
  }
  const value = current === "" ? "" : ` value="${escapeHtml(current)}"`;
  return `<input type="text" name="${name}" id="${name}" maxlength="${MAX_ANSWER_CHARS}" autocomplete="off"${value}>`;
}

/** The label above a control: a legend-style line for radios, a real label for everything else. */
function fieldHead(titleHtml: string, name: string, spec: ControlSpec): string {
  return usesRadios(spec) ? `<div class="t">${titleHtml}</div>` : `<label class="t" for="${name}">${titleHtml}</label>`;
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
  if (!isEditableQuestion(q)) {
    const what = q.fieldType === "file" ? "file upload" : "CAPTCHA";
    return `<div class="q"><div class="t">${title}</div><p class="note">This ${what} cannot be answered here.</p></div>`;
  }
  const name = applyFieldName(q.label);
  return `<div class="q">${fieldHead(title, name, q)}${renderControl(q, name, "")}${hintFor(q)}</div>`;
}

/** Required questions first; the order inside each group is the form's own order. */
function orderQuestions(qs: readonly ApplySnapshotQuestion[]): ApplySnapshotQuestion[] {
  return [...qs].sort((a, b) => Number(b.required) - Number(a.required));
}

function renderQuestions(qs: readonly ApplySnapshotQuestion[]): string {
  if (qs.length === 0) {
    return `<h2>Nothing left to answer</h2><p class="note">Every question has an answer. Review the values below, then press Submit in Telegram.</p>`;
  }
  return `<h2>Needs your answer (${qs.length})</h2>${qs.map(renderQuestion).join("")}`;
}

function clip(value: string): string {
  return value.length > SHOWN_VALUE_CHARS ? `${value.slice(0, SHOWN_VALUE_CHARS)}…` : value;
}

/** A filled value shown as text: a file by name, anything else by its (clipped) value. */
function renderStaticFilled(f: ApplySnapshotFilled): string {
  const shown = f.fieldType === "file" ? `${RESUME_LABEL.test(f.label) ? "CV" : "File"} attached: ${f.value}` : clip(f.value);
  return `<div class="q"><div class="t">${escapeHtml(f.label)}</div><p class="note val">${escapeHtml(shown)}</p></div>`;
}

function renderEditableFilled(f: ApplySnapshotFilled): string {
  const name = applyFieldName(f.label);
  return `<div class="q">${fieldHead(escapeHtml(f.label), name, f)}${renderControl(f, name, f.value)}</div>`;
}

/** The "Already filled" section, and whether it holds any input. Older snapshots carry labels only. */
function renderFilled(s: Summary): { readonly html: string; readonly editable: boolean } {
  if (s.filledAnswers.length === 0) {
    if (s.filledLabels.length === 0) return { html: "", editable: false };
    const items = s.filledLabels.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
    return { html: `<h2>Already filled (${s.filledLabels.length})</h2><ul>${items}</ul>`, editable: false };
  }
  const offered = new Set(editableFilled(s));
  const rows: string[] = [];
  for (const f of s.filledAnswers) {
    if (offered.has(f)) rows.push(renderEditableFilled(f));
    else if (!isEditableFilled(f)) rows.push(renderStaticFilled(f));
  }
  const note =
    offered.size > 0
      ? `<p class="note">Change a value if it is wrong, then save. A change is remembered for every form that asks the same question.</p>`
      : "";
  return { html: `<h2>Already filled (${rows.length})</h2>${note}${rows.join("")}`, editable: offered.size > 0 };
}

const FOOTER =
  `<p class="foot">This page never submits the application. After you save, the bot re-fills the form ` +
  `and sends the updated card to Telegram, where you press Submit.</p>`;

const MINI_PANEL =
  `<section id="mini" hidden><p id="mini-status" role="status" class="note"></p>` +
  `<div id="mini-confirm" hidden><p id="mini-confirm-text"></p>` +
  `<button type="button" id="mini-yes">Yes, submit</button><button type="button" id="mini-back" class="alt">Back</button></div>` +
  `<button type="button" id="mini-cancel" class="alt" hidden>Cancel application</button></section>`;

const MINI_FOOTER =
  `<p class="foot">Saving answers makes the bot re-fill the form. Inside Telegram, Submit appears here once the form is ready; ` +
  `it asks you to confirm before anything is sent.</p>`;

/** The answer page for one snapshot. A nonce adds the Telegram script panel (the route sends the matching CSP). */
export function renderApplyPage(snap: ApplySnapshot, opts: { readonly nonce?: string } = {}): string {
  const s = snap.summary;
  const title = `${snap.company}: ${snap.title}`;
  const intro = `${snap.platform} application for ${snap.candidateName}. ${s.filled} of ${s.total} fields filled.`;
  const warn = s.hasCaptcha
    ? `<p class="warn">This form has a CAPTCHA the bot cannot solve, so it may not be submittable from Telegram.</p>`
    : "";
  const questions = orderQuestions(s.unanswered);
  const filled = renderFilled(s);
  const sections = renderQuestions(questions) + filled.html;
  const body = questions.some(isEditableQuestion) || filled.editable
    ? `<form method="post">${sections}<button type="submit">Save answers and re-fill</button></form>`
    : sections;
  const head = `<h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(intro)}</p>${warn}`;
  const nonce = opts.nonce;
  if (!nonce) return shell(title, head + body + FOOTER);
  const attrs = ` data-created="${snap.createdAt}" data-company="${escapeHtml(snap.company)}"`;
  const n = escapeHtml(nonce);
  const scripts = `<script nonce="${n}" src="${TELEGRAM_SCRIPT_HOST}/js/telegram-web-app.js"></script><script nonce="${n}">${APPLY_PAGE_SCRIPT}</script>`;
  return shell(title, head + MINI_PANEL + body + `<p id="mini-save" role="status" class="note"></p>` + MINI_FOOTER, attrs, scripts);
}
