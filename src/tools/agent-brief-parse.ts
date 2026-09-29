/**
 * FounderOS — reading an agent brief as Markdown
 * ==============================================
 * The pure parsing half of the brief lint (./agent-brief-lint.ts): which of the template's nine
 * sections have content, and which repo paths the brief cites. No fs, no network, no clock.
 *
 * A brief is read the way GitHub renders it: fenced code blocks and HTML comments are not text,
 * a heading inside either is not a heading, and only a level-2 heading is a template section.
 * See the lint's header for the deliberate limits of what is and is not checked.
 */

import { posix } from "node:path";

/**
 * The `##` headings of .github/ISSUE_TEMPLATE/agent-task.md, in template order. The dispatcher's
 * claim-time check (AGENT_BRIEF_HEADINGS in deploy/agent-dispatch) must list the same nine; a
 * test compares this list to the template so the two cannot drift apart.
 */
export const AGENT_BRIEF_HEADINGS = [
  "Goal",
  "Problem / observed behavior",
  "Expected behavior",
  "Evidence",
  "Files or subsystem in scope",
  "Constraints",
  "Explicitly forbidden",
  "Verification commands",
  "Acceptance criteria",
] as const;

export type AgentBriefHeading = (typeof AGENT_BRIEF_HEADINGS)[number];

/** The section whose plain-text paths are checked even without backticks. */
export const SCOPE_HEADING: AgentBriefHeading = "Files or subsystem in scope";

/** Roots under which a backticked path is checked anywhere in a brief. */
export const BRIEF_PATH_ROOTS = ["src", "scripts", "deploy", "tests"] as const;

/** A heading containing this text (any case) exempts everything under it from the path check. */
export const NEW_FILE_HEADING_TEXT = "new file";

// ── Markdown structure ────────────────────────────────────────────────────────

export interface BriefLine {
  /** The line with HTML comments removed. Empty inside a fence. */
  readonly text: string;
  readonly fenced: boolean;
  /** Non-blank code inside a fence: content for the emptiness check, never scanned. */
  readonly fenceContent: boolean;
}

const BACKTICK_FENCE = /^ {0,3}(`{3,})([^`]*)$/;
const TILDE_FENCE = /^ {0,3}(~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

/** Splits a body into lines, removing HTML comments and marking fenced code. */
export function scanLines(body: string): BriefLine[] {
  const out: BriefLine[] = [];
  let fence: { readonly char: string; readonly length: number } | null = null;
  let inComment = false;

  for (const raw of body.split(/\r?\n/)) {
    if (fence) {
      const close = (fence.char === "`" ? BACKTICK_FENCE : TILDE_FENCE).exec(raw);
      const closes = close?.[1] !== undefined && close[1].length >= fence.length && raw.trim() === close[1];
      if (closes) fence = null;
      out.push({ text: "", fenced: true, fenceContent: !closes && raw.trim() !== "" });
      continue;
    }

    let text = "";
    let rest = raw;
    while (rest !== "") {
      if (inComment) {
        const end = rest.indexOf("-->");
        inComment = end < 0;
        rest = end < 0 ? "" : rest.slice(end + 3);
      } else {
        const start = rest.indexOf("<!--");
        text += start < 0 ? rest : rest.slice(0, start);
        inComment = start >= 0;
        rest = start < 0 ? "" : rest.slice(start + 4);
      }
    }

    const open = BACKTICK_FENCE.exec(text) ?? TILDE_FENCE.exec(text);
    if (open?.[1]) {
      fence = { char: open[1].charAt(0), length: open[1].length };
      out.push({ text: "", fenced: true, fenceContent: false });
      continue;
    }
    out.push({ text, fenced: false, fenceContent: false });
  }
  return out;
}

interface Heading {
  readonly level: number;
  readonly title: string;
}

function headingOf(text: string): Heading | null {
  const match = ATX_HEADING.exec(text);
  if (!match?.[1]) return null;
  let title = (match[2] ?? "").trim();
  // A closing run of #s counts only when a space precedes it: `## Goal ##` yes, `## C#` no.
  // Scanned by hand, not with a lazy regex: those backtrack quadratically on a long run of spaces.
  let end = title.length;
  while (end > 0 && title.charAt(end - 1) === "#") end--;
  if (end < title.length && end > 0 && /\s/.test(title.charAt(end - 1))) title = title.slice(0, end).trimEnd();
  return title === "" ? null : { level: match[1].length, title };
}

function normalizeTitle(title: string): string {
  const collapsed = title.toLowerCase().replace(/\s+/g, " ");
  let end = collapsed.length;
  while (end > 0 && (collapsed.charAt(end - 1) === ":" || collapsed.charAt(end - 1) === " ")) end--;
  return collapsed.slice(0, end).trim();
}

// ── Template sections ─────────────────────────────────────────────────────────

/** Which level-2 sections exist, and whether any occurrence of each has content. */
function sectionContent(lines: readonly BriefLine[]): Map<string, boolean> {
  const sections = new Map<string, boolean>();
  let current: string | null = null;

  for (const line of lines) {
    if (!line.fenced) {
      const heading = headingOf(line.text);
      if (heading) {
        if (heading.level <= 2) current = null;
        if (heading.level === 2) {
          current = normalizeTitle(heading.title);
          if (!sections.has(current)) sections.set(current, false);
        }
        continue;
      }
    }
    const hasContent = line.fenced ? line.fenceContent : line.text.trim() !== "";
    if (current !== null && hasContent) sections.set(current, true);
  }
  return sections;
}

export function checkHeadings(lines: readonly BriefLine[]): { missing: string[]; empty: string[] } {
  const sections = sectionContent(lines);
  const missing: string[] = [];
  const empty: string[] = [];
  for (const heading of AGENT_BRIEF_HEADINGS) {
    const filled = sections.get(normalizeTitle(heading));
    if (filled === true) continue;
    missing.push(heading);
    if (filled === false) empty.push(heading);
  }
  return { missing, empty };
}

// ── Cited paths ───────────────────────────────────────────────────────────────

/** Characters a checkable path may contain. Anything else (`*`, `<`, `{`, `…`, `:`) is not a path. */
const PATH_CHARS = /^[A-Za-z0-9._@+/-]+$/;
const LINE_REFERENCE = /(?::L?\d+(?:[:-]L?\d+)*|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/;
/** A name that is a file, not a directory: it cannot be followed by a child segment. */
const FILE_NAME = /\.(?:[cm]?[jt]sx?|json|mdx?|sh|ya?ml|py|sql|s?css|html|txt|toml|env|lock)$/i;
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const LEADING_EDGE = /^[([{"']+/;
const TRAILING_EDGE = /[)\]}"'.,;:!?]+$/;

/**
 * Longest token treated as a path. A real repo path is far shorter; anything longer is degenerate
 * text, and bounding it keeps the regexes below linear (a 65,000-character "token" of colons or
 * dots would otherwise cost seconds of event-loop time).
 */
const MAX_PATH_TOKEN_CHARS = 400;

function stripEdges(token: string): string {
  return token.replace(LEADING_EDGE, "").replace(TRAILING_EDGE, "");
}

/**
 * A repo-relative path from one token, or null when the token is not a checkable path.
 *
 * `scope` tokens come from plain text in the scope section, so they must look like a path on
 * their own (a slash, plus a file extension, a trailing slash or a known root). Backticked
 * tokens are already deliberate, so they only have to sit under one of the four roots.
 */
function toRepoPath(raw: string, scope: boolean): string | null {
  if (raw.length > MAX_PATH_TOKEN_CHARS) return null;
  let token = raw.trim();
  const emphasis = /^(\*{1,3})([^*]+)\1$/.exec(token);
  if (emphasis?.[2]) token = emphasis[2];
  if (token.includes("*")) return null;

  token = stripEdges(stripEdges(token).replace(LINE_REFERENCE, ""));
  if (token === "" || !PATH_CHARS.test(token)) return null;

  const isDirectory = token.endsWith("/");
  const normalized = posix.normalize(token);
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) return null;

  const path = normalized.replace(/\/+$/, "");
  const segments = path.split("/");
  const first = segments[0] ?? "";
  if (path === "" || path === "." || first === "") return null;
  if (segments.length < 2 && !isDirectory) return null;
  if (first.startsWith("@")) return null;
  if (first.includes(".") && !first.startsWith(".")) return null;
  if (segments.slice(0, -1).some((segment) => FILE_NAME.test(segment))) return null;

  const underRoot = (BRIEF_PATH_ROOTS as readonly string[]).includes(first);
  if (!scope) return underRoot ? path : null;
  return underRoot || isDirectory || HAS_EXTENSION.test(segments[segments.length - 1] ?? "") ? path : null;
}

/** Tokens of a scope-section line. Placeholders become a marker no path can contain. */
function scopeTokens(text: string): string[] {
  return text
    .replace(/\[([^\]]{0,200})\]\(([^)\s]{0,300})\)/g, " $1 $2 ")
    .replace(/<[^<>]*>/g, "\uFFFF")
    .replace(/`/g, " ")
    .split(/[\s,;]+/)
    .filter((token) => token !== "");
}

/** Backticked spans that are a single token: a command like `pnpm test x` is not a path. */
function backtickedTokens(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter((span) => span !== "" && !/\s/.test(span));
}

/** Every path the brief cites that must exist, scope section first, each once. */
export function collectPaths(lines: readonly BriefLine[]): string[] {
  const scopeKey = normalizeTitle(SCOPE_HEADING);
  const stack: Heading[] = [];
  const inScope: string[] = [];
  const backticked: string[] = [];

  for (const line of lines) {
    if (line.fenced) continue;
    const heading = headingOf(line.text);
    if (heading) {
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) stack.pop();
      stack.push(heading);
      continue;
    }
    if (stack.some((h) => h.title.toLowerCase().includes(NEW_FILE_HEADING_TEXT))) continue;

    for (const token of backtickedTokens(line.text)) {
      const path = toRepoPath(token, false);
      if (path) backticked.push(path);
    }
    if (stack.some((h) => h.level === 2 && normalizeTitle(h.title) === scopeKey)) {
      for (const token of scopeTokens(line.text)) {
        const path = toRepoPath(token, true);
        if (path) inScope.push(path);
      }
    }
  }
  return [...new Set([...inScope, ...backticked])];
}
