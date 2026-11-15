/**
 * FounderOS — read a filled-in question document
 * ==============================================
 * A candidate answers `tashi-questions.md` in a chat app, so the text that comes back is messy: answers on the
 * question line or under it, bullets, "A:" prefixes, blank lines, Windows line endings, numbers that drifted
 * after she deleted a question. This turns it into one record per question. No model reads it: matching is
 * token overlap against the known stems (answer-doc-questions.ts), the same way every time.
 *
 * `answer` is the text she wrote, "skip" when she wants to be asked on each form, or null when she left it blank.
 *
 * PURE (`STANDARDS.md` §2).
 */

import { ANSWER_DOC_QUESTIONS, ANSWER_DOC_SECTIONS, type DocQuestion } from "./answer-doc-questions.js";

export interface ParsedAnswer {
  /** The template number when the question was recognised (by text first, then by number), else the number she wrote. */
  readonly number: number;
  readonly question: string;
  readonly answer: string | "skip" | null;
  /** False when the question matched no template question, so the mapper files it as plain Q&A under her own wording. */
  readonly recognised: boolean;
}

interface Tok { readonly norm: string; readonly end: number }

const tokens = (s: string): Tok[] =>
  [...s.matchAll(/\S+/g)]
    .map((m) => ({ norm: m[0].toLowerCase().replace(/[^a-z0-9]+/g, ""), end: (m.index ?? 0) + m[0].length }))
    .filter((t) => t.norm.length > 0);

const stemToks = new Map(ANSWER_DOC_QUESTIONS.map((d) => [d.n, tokens(d.stem)]));
const stemSets = new Map(ANSWER_DOC_QUESTIONS.map((d) => [d.n, new Set(stemToks.get(d.n)!.map((t) => t.norm))]));
const SECTION_SET = new Set(ANSWER_DOC_SECTIONS);

const START = /^(?:[-*•]\s*)?(?:\*\*)?(?:Q\s*)?(\d{1,3})\s*[.):]\s*(?:\*\*)?\s*(.*)$/i;
const FILLER = /^[_.\-–—…\s]*$/;

/** The text after a verbatim template stem (or its part before the "(yes / no)" hint), or null. */
function inlineAfterStem(body: string): { readonly n: number; readonly rest: string } | null {
  const bt = tokens(body);
  let best: { n: number; len: number; rest: string } | null = null;
  for (const d of ANSWER_DOC_QUESTIONS) {
    const full = stemToks.get(d.n)!;
    const paren = d.stem.indexOf("(");
    const stem = paren > 0 ? tokens(d.stem.slice(0, paren)) : full;
    for (const cand of paren > 0 ? [full, stem] : [full]) {
      if (cand.length < 3 || bt.length < cand.length) continue;
      if (!cand.every((t, i) => t.norm === bt[i]!.norm)) continue;
      if (!best || cand.length > best.len) best = { n: d.n, len: cand.length, rest: body.slice(bt[cand.length - 1]!.end) };
    }
  }
  return best ? { n: best.n, rest: best.rest } : null;
}

function resolve(written: number, question: string): number | null {
  const a = new Set(tokens(question).map((t) => t.norm));
  if (a.size === 0) return null;
  const score = (n: number): { jac: number; cont: number } => {
    const b = stemSets.get(n)!;
    const inter = [...a].filter((t) => b.has(t)).length;
    return { jac: inter / (a.size + b.size - inter), cont: inter / Math.min(a.size, b.size) };
  };
  const scored = ANSWER_DOC_QUESTIONS.map((d: DocQuestion) => ({ n: d.n, ...score(d.n) }));
  const byJac = [...scored].sort((x, y) => y.jac - x.jac)[0]!;
  if (byJac.jac >= 0.6) return byJac.n;
  const own = scored.find((s) => s.n === written);
  if (own && own.cont >= 0.5) return own.n;
  const byCont = scored.filter((s) => s.cont >= 0.8 && a.size >= 2).sort((x, y) => y.cont - x.cont)[0];
  return byCont ? byCont.n : null;
}

function splitInline(body: string): { readonly question: string; readonly rest: string } {
  const cut = /[?:]/.exec(body);
  if (!cut || cut.index === undefined) return { question: body.trim(), rest: "" };
  const end = cut[0] === "?" ? cut.index + 1 : cut.index;
  return { question: body.slice(0, end).trim(), rest: body.slice(cut.index + 1) };
}

function cleanLine(line: string): string {
  return line
    .replace(/\*\*|__/g, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/^\s*(?:A|Ans|Answer)\s*[:.)-]\s*/i, "")
    .replace(/^[\s:=–—-]+/, "")
    .trim();
}

function finish(question: string, parts: readonly string[], written: number, matched: number | null): ParsedAnswer {
  const text = parts.map(cleanLine).filter((p) => !FILLER.test(p)).join(" ").replace(/\s+/g, " ").trim();
  const answer = text === "" ? null : /^\(?skip\)?[.!]?$/i.test(text) ? "skip" : text;
  const canonical = matched !== null ? ANSWER_DOC_QUESTIONS.find((d) => d.n === matched) : undefined;
  return { number: matched ?? written, question: canonical?.stem ?? question, answer, recognised: matched !== null };
}

export function parseAnswerDoc(text: string): ParsedAnswer[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
  const found = new Map<number, ParsedAnswer>();
  const order: number[] = [];
  let open: { written: number; question: string; matched: number | null; parts: string[] } | null = null;
  let lastWritten = 0;

  const close = (): void => {
    if (!open) return;
    const rec = finish(open.question, open.parts, open.written, open.matched);
    const key = rec.recognised ? rec.number : 1000 + order.length;
    if (!found.has(key)) order.push(key);
    found.set(key, rec); // a later answer to the same question is a correction
    open = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/^\s*>+\s?/, "").trim();
    if (line === "") continue;
    if (/^#{1,6}\s/.test(line) || /^[-_=*]{3,}$/.test(line)) { close(); continue; }
    const m = START.exec(line);
    if (m) {
      const written = Number(m[1]);
      const body = (m[2] ?? "").replace(/\*\*/g, "").trim();
      if (SECTION_SET.has(body.toLowerCase().replace(/[^a-z ]+/g, "").trim())) { close(); continue; }
      const verbatim = inlineAfterStem(body);
      const { question, rest } = verbatim ? { question: ANSWER_DOC_QUESTIONS[verbatim.n - 1]!.stem, rest: verbatim.rest } : splitInline(body);
      const matched = verbatim ? verbatim.n : resolve(written, question);
      if (matched !== null || written === lastWritten + 1 || open === null) {
        close();
        lastWritten = written;
        open = { written, question, matched, parts: rest.trim() ? [rest] : [] };
        continue;
      }
    }
    open?.parts.push(line);
  }
  close();
  return order.map((k) => found.get(k)!).sort((a, b) => a.number - b.number);
}
