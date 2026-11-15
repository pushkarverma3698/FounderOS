/**
 * Hand-off panel: HTML
 * ====================
 * Two pure renderers. The shell is what the web_app button opens: it holds no personal data, only the script
 * that asks for the panel with Telegram's signed initData. The panel is the HTML fragment that answer carries:
 * the big link to the company's form, then every answer as label + value + a Copy button, the cover letter,
 * the PDFs, and "I applied". Everything from the profile, the dossier or the form is escaped.
 * Same shell, style hash and Telegram script as the answer page (apply-page.ts), so the CSP is unchanged.
 */

import type { ApplySnapshot } from "../tools/jobhunt/apply-link.js";
import type { HandoffRow } from "../tools/jobhunt/handoff-rows.js";
import { APPLY_HANDOFF_SCRIPT } from "./apply-handoff-script.js";
import { escapeHtml, shell } from "./apply-page.js";

const TELEGRAM_SCRIPT = "https://telegram.org/js/telegram-web-app.js";
const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url);

export interface HandoffModel {
  readonly company: string;
  readonly title: string;
  readonly jobUrl: string;
  readonly rows: readonly HandoffRow[];
  /** Why the bot stopped, in words for the candidate. */
  readonly reason?: string;
  /** Set for a Workday job: the address to sign in or sign up with. */
  readonly workdayEmail?: string;
  readonly hasCv: boolean;
  readonly hasLetterPdf: boolean;
  /** A line for a problem that left the panel short (no profile on file). */
  readonly warning?: string;
}

/** The page the button opens: no personal data, a loading line, and the nonce'd script. */
export function renderHandoffShell(snap: Pick<ApplySnapshot, "rowId" | "company" | "title">, nonce: string): string {
  const title = `${snap.company}: copy answers`;
  const n = escapeHtml(nonce);
  const head = `<h1>${escapeHtml(snap.company)}</h1><p class="sub">${escapeHtml(snap.title)}</p>`;
  const body = `<div id="ho-body"><p class="note" id="ho-status" role="status">Loading your answers.</p></div>`;
  const scripts = `<script nonce="${n}" src="${TELEGRAM_SCRIPT}"></script><script nonce="${n}">${APPLY_HANDOFF_SCRIPT}</script>`;
  return shell(title, head + body, ` data-row="${escapeHtml(snap.rowId)}"`, scripts);
}

function renderRows(rows: readonly HandoffRow[]): string {
  let out = "";
  let group = "";
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      out += `<h2>${escapeHtml(group)}</h2>`;
    }
    const id = `ho-v-${escapeHtml(r.id)}`;
    out += `<div class="q"><div class="t">${escapeHtml(r.label)}</div><p class="val" id="${id}">${escapeHtml(r.value)}</p>` +
      `<button type="button" class="copy" data-copy="${id}">Copy</button></div>`;
  }
  return out;
}

function renderFiles(m: HandoffModel): string {
  if (!m.hasCv && !m.hasLetterPdf) return "";
  const cv = m.hasCv ? `<button type="button" class="alt" data-file="cv">Download tailored CV (PDF)</button>` : "";
  const letter = m.hasLetterPdf ? `<button type="button" class="alt" data-file="letter">Download cover letter (PDF)</button>` : "";
  return `<h2>Files</h2>${cv}${letter}`;
}

/** The panel fragment. */
export function renderHandoffPanel(m: HandoffModel): string {
  const link = isWebUrl(m.jobUrl)
    ? `<a id="ho-open" class="go" href="${escapeHtml(m.jobUrl)}" target="_blank" rel="noopener noreferrer">Open the company's form</a>`
    : `<p class="warn">The job address on file is not a web link; open the job from the original listing.</p>`;
  const reason = m.reason ? `<p class="note">${escapeHtml(m.reason)}</p>` : "";
  const workday = m.workdayEmail
    ? `<p class="warn">Workday needs an account per company: sign in or create one with ${escapeHtml(m.workdayEmail)}, then paste below.</p>`
    : "";
  const warning = m.warning ? `<p class="warn">${escapeHtml(m.warning)}</p>` : "";
  const applied =
    `<h2>Done?</h2><p class="note">Tap once the company showed its thank-you page. The role is then counted as applied.</p>` +
    `<button type="button" id="ho-applied">✅ I applied</button><p class="note" id="ho-applied-note" role="status"></p>`;
  return link + reason + workday + warning + renderRows(m.rows) + renderFiles(m) + applied;
}
