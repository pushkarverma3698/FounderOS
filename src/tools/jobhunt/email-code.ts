/**
 * Emailed security code: pure parser (no I/O, no model). Picks the one-time code out of recent mail so the
 * held apply form can be unlocked without the founder typing it. It only accepts a mail that is
 * (1) newer than the Submit click, (2) from an allow-listed applicant-tracking sender, (3) names the company,
 * and it refuses to guess: two different codes mean null and the founder types it as before.
 */

import { CODE_PATTERN } from "./held-submit.js";

export interface CodeMail {
  readonly sender: string;
  readonly subject: string;
  readonly body: string;
  /** Epoch ms; NaN when the Date header did not parse (such a mail is never accepted). */
  readonly receivedAt: number;
}

export interface ExtractOptions {
  readonly company: string;
  /** Epoch ms of the Submit click. Mails received before it (to the second) are stale. */
  readonly sentAfter: number;
  readonly senderAllow?: readonly string[];
}

export const CODE_SENDER_ALLOW: readonly string[] = [
  "greenhouse-mail.io", "greenhouse.io", "hire.lever.co", "lever.co",
  "myworkday.com", "smartrecruiters.com", "recruitee.com", "workable.com",
];

const LEGAL_SUFFIX = /\b(inc|llc|ltd|limited|gmbh|bv|b v|nv|n v|corp|corporation|co|plc|ag|sa|sas)\b\.?/g;
const KEYWORD = /\b(?:code|pin)\b/gi;
const CODE_WINDOW = 80;

const squash = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

function companyNeedle(company: string): string {
  const base = company.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
  return base ? ` ${base} ` : "";
}

/** Domain of the From header (angle-bracket address or a bare one), lower case, or "". */
export function senderDomain(sender: string): string {
  const addr = /<([^>]+)>/.exec(sender)?.[1] ?? sender;
  const at = addr.lastIndexOf("@");
  return at < 0 ? "" : addr.slice(at + 1).trim().toLowerCase().replace(/[>\s]+$/, "");
}

export function senderAllowed(sender: string, allow: readonly string[] = CODE_SENDER_ALLOW): boolean {
  const d = senderDomain(sender);
  return d !== "" && allow.some((a) => d === a || d.endsWith(`.${a}`));
}

const looksLikeYear = (t: string): boolean => /^(19|20)\d{2}$/.test(t);

/** First token within a short window after each "code" keyword that fits CODE_PATTERN and holds a digit (plain words never qualify). */
function codesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(KEYWORD)) {
    const from = (m.index ?? 0) + m[0].length;
    const window = text.slice(from, from + CODE_WINDOW);
    for (const t of window.match(/[A-Za-z0-9]+/g) ?? []) {
      if (CODE_PATTERN.test(t) && /\d/.test(t) && !looksLikeYear(t)) {
        out.push(t);
        break;
      }
    }
  }
  return out;
}

/** Every distinct code in the qualifying mails (empty, one, or several). */
export function findEmailCodes(mails: readonly CodeMail[], opts: ExtractOptions): string[] {
  const needle = companyNeedle(opts.company);
  if (!needle) return [];
  const floor = Math.floor(opts.sentAfter / 1000) * 1000;
  const found = new Set<string>();
  for (const m of mails) {
    if (!(m.receivedAt >= floor)) continue;
    if (!senderAllowed(m.sender, opts.senderAllow)) continue;
    if (!squash(`${m.subject} ${m.body}`).includes(needle)) continue;
    for (const c of codesIn(`${m.subject}\n${m.body}`)) found.add(c);
  }
  return [...found];
}

/** The code, or null when there is none or more than one (never guess). */
export function extractEmailCode(mails: readonly CodeMail[], opts: ExtractOptions): string | null {
  const codes = findEmailCodes(mails, opts);
  return codes.length === 1 ? codes[0]! : null;
}

/** Parses the provider's formatted Gmail list ("N. From: x · date / Subject: s / body"). */
export function parseEmailList(text: string): CodeMail[] {
  const mails: CodeMail[] = [];
  for (const block of text.split(/\n(?=\d+\. From: )/)) {
    const m = /^\d+\. From: (.*?)(?: · ([^\n]*))?\n\s+Subject: ([^\n]*)(?:\n\s+([\s\S]*))?$/.exec(block.trim());
    if (!m) continue;
    mails.push({ sender: m[1]!.trim(), subject: m[3]!.trim(), body: (m[4] ?? "").trim(), receivedAt: Date.parse(m[2] ?? "") });
  }
  return mails;
}
