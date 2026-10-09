/**
 * FounderOS — the merge card the founder decides on in the coding pipeline, and the layout helpers the blocked card
 * (blocked-card.ts) shares with it.
 *
 * Merge card: the PR's required CI, pr-brain's review and the merge gate, with the merge button. It is keyed on the
 * job (a task/issue-N PR), not on a spec contract (AG-062).
 *
 * Pure renderers: no Telegram client, no network, no clock.
 * Invariants these functions hold, because the founder acts on what they print:
 *  - Fail closed. Anything that is not exactly PASS (or exactly APPROVE, or merge.ok === true) is
 *    never shown as a tick and never gets a merge button. A missing review is UNKNOWN, not PASS.
 *  - A reason is never dropped (CLAUDE.md #26). Every non-PASS row prints all of its reasons. When a
 *    card is longer than one Telegram message it is split across messages, never truncated.
 *  - Every string that came from a model, a repo or a reviewer is HTML-escaped.
 *  - Callback data is cp:<action>:<nonce>, at most 64 bytes; parseCodingCallback is its only reader.
 *
 * Renderers return html as an array of messages. Send them in order and attach the keyboard to
 * the LAST one. Callers must not join the array: the parts are each under the Telegram limit.
 */
import { InlineKeyboard } from "grammy";
import { safeHtml } from "./approval-card.js";

/** Telegram rejects a message whose text is 4096 characters or longer. */
export const TELEGRAM_HTML_LIMIT = 4096;
/** One message is packed to at most this many characters, leaving headroom under the limit. */
const PART_BUDGET = 3800;
/** One printed line holds at most this many escaped characters; longer text continues on the next line. */
const LINE_BUDGET = 1200;

export const CODING_ACTIONS = ["merge", "fix", "close_pr"] as const;
export type CodingAction = (typeof CODING_ACTIONS)[number];
export interface CodingCallback {
  action: CodingAction;
  nonce: string;
}
export interface Card {
  /** One entry per Telegram message, in send order. Each is under TELEGRAM_HTML_LIMIT. */
  html: string[];
  /** Belongs on the last message. */
  keyboard: InlineKeyboard;
}

const MAX_CALLBACK_BYTES = 64;
const NONCE_PATTERN = "[A-Za-z0-9_-]{1,32}";
const NONCE_RE = new RegExp("^" + NONCE_PATTERN + "$");
const CALLBACK_RE = new RegExp("^cp:(" + CODING_ACTIONS.join("|") + "):(" + NONCE_PATTERN + ")$");

export function assertNonce(nonce: string): void {
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
    throw new Error("coding card nonce must match " + NONCE_PATTERN);
  }
}

export function callbackData(action: CodingAction, nonce: string): string {
  const data = "cp:" + action + ":" + nonce;
  if (Buffer.byteLength(data, "utf8") > MAX_CALLBACK_BYTES) throw new Error("callback data over 64 bytes");
  return data;
}

/** The only reader of cp: callback data. Anything that is not exactly our format is null. */
export function parseCodingCallback(data: unknown): CodingCallback | null {
  if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_CALLBACK_BYTES) return null;
  const m = CALLBACK_RE.exec(data);
  if (m === null) return null;
  const action = m[1];
  const nonce = m[2];
  if (action === undefined || nonce === undefined) return null;
  return { action: action as CodingAction, nonce };
}

// ── text layout ─────────────────────────────────────────────────────────────

function wrap(tag: string, inner: string): string {
  return "<" + tag + ">" + inner + "</" + tag + ">";
}

/**
 * Escape untrusted text and cut it into pieces of at most `max` escaped characters. Cuts fall between
 * code points, so an entity or a surrogate pair is never split. Always returns at least one piece.
 */
function escapedPieces(raw: string, max: number = LINE_BUDGET): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of String(raw)) {
    const e = safeHtml(ch);
    if (cur.length + e.length > max) {
      out.push(cur);
      cur = "";
    }
    cur += e;
  }
  out.push(cur);
  return out;
}

/** A labelled value as printed lines. The label is trusted markup; the value is untrusted text. */
export function field(label: string, raw: string, tag?: string): string[] {
  return escapedPieces(raw).map((piece, i) => {
    const body = tag === undefined ? piece : wrap(tag, piece);
    return (i === 0 ? label : "  ") + body;
  });
}

/** Pack lines into messages. A line is never split here, and every line is short, so none is lost. */
export function packLines(lines: string[]): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur !== "" && cur.length + 1 + line.length > PART_BUDGET) {
      parts.push(cur);
      cur = line;
    } else {
      cur = cur === "" ? line : cur + "\n" + line;
    }
  }
  if (cur !== "" || parts.length === 0) parts.push(cur);
  return parts;
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.map((v) => String(v)) : [];
}

// ── evidence card ───────────────────────────────────────────────────────────

/** A narrow local shape: this file does not import the review module. */
export interface CardReview {
  decision: string;
  findings: ReadonlyArray<{ severity: string; claim: string; file?: string; line?: number }>;
}
export interface CardVerdict {
  status: string;
  reasons: readonly string[];
}
export interface EvidenceCardInput {
  /** The PR's required CI checks at the head under review. */
  ci: CardVerdict;
  /** Null when no review ran. That is UNKNOWN, never a pass. */
  review: CardReview | null;
  /** The merge gate (canMerge). Only the boolean true counts. */
  merge: { ok: boolean; reasons: readonly string[] };
  prUrl: string;
  nonce: string;
  /** What the card is about: the founder reads this before any row (CLAUDE.md #26). The title is untrusted text. */
  subject: { repo: string; pr: number; issue: number; title: string };
}

type Mark = "PASS" | "FAIL" | "UNKNOWN";
const MARK_TEXT: Record<Mark, string> = { PASS: "✓ PASS", FAIL: "✗ FAIL", UNKNOWN: "? UNKNOWN" };

/** Exact-match only: a lowercase or misspelt status is UNKNOWN, never a pass. */
function markOf(status: unknown): Mark {
  return status === "PASS" || status === "FAIL" ? status : "UNKNOWN";
}

function reviewMark(review: CardReview | null): Mark {
  if (review === null || typeof review !== "object") return "UNKNOWN";
  if (review.decision === "APPROVE") return "PASS";
  if (review.decision === "REQUEST_CHANGES") return "FAIL";
  return "UNKNOWN";
}

function findingText(f: CardReview["findings"][number]): string {
  const where = f.file === undefined ? "" : " (" + f.file + (typeof f.line === "number" ? ":" + f.line : "") + ")";
  return "[" + String(f.severity) + "] " + String(f.claim) + where;
}

function bullets(items: string[], fallback: string): string[] {
  const out: string[] = [];
  const list = items.length === 0 ? [fallback] : items;
  for (const item of list) out.push(...field("  • ", item));
  return out;
}

function row(label: string, mark: Mark, reasons: string[]): string[] {
  const head = label + ": " + MARK_TEXT[mark];
  return mark === "PASS" ? [head] : [head, ...bullets(reasons, "no reason given")];
}

export function assertHttpsUrl(url: string): void {
  let ok = false;
  try {
    ok = typeof url === "string" && new URL(url).protocol === "https:";
  } catch {
    // allow-failopen: a URL that does not parse is rejected by the throw directly below
    ok = false;
  }
  if (!ok) throw new Error("coding card prUrl must be an https URL");
}

/**
 * The merge card: Required CI / Review / Gate, each with its mark, every non-PASS row with all of its reasons, then the
 * buttons. [Merge] needs all three rows PASS (review APPROVE, merge.ok exactly true). Otherwise there is none.
 */
export function renderEvidenceCard(input: EvidenceCardInput): Card {
  assertNonce(input.nonce);
  assertHttpsUrl(input.prUrl);
  const ciMark = markOf(input.ci?.status);
  const reviewM = reviewMark(input.review);
  const gateMark: Mark = input.merge?.ok === true ? "PASS" : input.merge?.ok === false ? "FAIL" : "UNKNOWN";

  const title = String(input.subject?.title ?? "").replace(/\s+/g, " ").trim() || "(no title)";
  const s = input.subject;
  const lines: string[] = field(wrap("b", "Ready to merge?") + " ", `${s?.repo}#${s?.pr} (issue #${s?.issue}): ${title}`);
  lines.push(...row("Required CI", ciMark, strings(input.ci?.reasons)));
  const findings = input.review === null || !Array.isArray(input.review.findings) ? [] : input.review.findings;
  const reviewHead = "Review: " + MARK_TEXT[reviewM];
  if (reviewM === "PASS" && findings.length === 0) {
    lines.push(reviewHead);
  } else {
    const noReview = input.review === null ? ["no review ran"] : [];
    lines.push(reviewHead, ...bullets(noReview.concat(findings.map(findingText)), "no reason given"));
  }
  lines.push(...row("Gate", gateMark, strings(input.merge?.reasons)));

  const rowsPass = ciMark === "PASS" && reviewM === "PASS";
  if (gateMark === "PASS" && !rowsPass) {
    lines.push("", wrap("b", "Gate says mergeable but a row above is not PASS. The gate and the rows are inconsistent, so there is no merge button."));
  }

  const keyboard = new InlineKeyboard();
  if (rowsPass && gateMark === "PASS") keyboard.text("🚀 Merge", callbackData("merge", input.nonce)).row();
  keyboard.url("🔗 Open PR", input.prUrl);
  return { html: packLines(lines), keyboard };
}
