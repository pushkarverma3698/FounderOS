/**
 * FounderOS — Telegram Message Formatting
 * ========================================
 * The office's LLM emits Markdown (**bold**, bullets, `code`, headings, links).
 * Telegram's Bot API does NOT render Markdown when you send with parse_mode
 * "HTML" — and it only supports a small HTML subset: <b> <i> <u> <s> <code>
 * <pre> <a href> <blockquote>. The previous gateway HTML-escaped the whole
 * reply, so Markdown leaked through as literal asterisks ("low grade" replies).
 *
 * This module does two things, both pure (easy to unit-test):
 *   1. markdownToTelegramHtml — Markdown → Telegram-safe HTML, escaping literal
 *      text so user content can never inject markup.
 *   2. splitForTelegram — chunk long output under Telegram's 4096-char hard
 *      limit on word/line boundaries (Telegram rejects longer messages).
 *
 * Design choice: a small, dependency-free converter covering the Markdown the
 * model actually produces. Not a full CommonMark parser — that's overkill and a
 * supply-chain risk for a chat gateway.
 */

/** Telegram's hard per-message character limit. */
export const TELEGRAM_MAX = 4096;

/** Escape the characters that are significant in Telegram HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Convert LaTeX display and inline math expressions to readable plain text. */
export function cleanLatexMath(input: string): string {
  let text = input.replace(/\$\$([\s\S]*?)\$\$/g, (_m, math: string) => convertMathExpression(math));
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_m, math: string) => convertMathExpression(math));
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_m, math: string) => convertMathExpression(math));
  return text;
}

function convertMathExpression(math: string): string {
  let res = math.trim();
  res = res.replace(/\\text\{([^}]+)\}/g, "$1");
  res = res.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "($1 / $2)");
  res = res.replace(/\\approx/g, "≈");
  res = res.replace(/\\times/g, "×");
  res = res.replace(/\\sim/g, "~");
  res = res.replace(/\\le\b/g, "≤").replace(/\\ge\b/g, "≥");
  res = res.replace(/\\pm/g, "±");
  res = res.replace(/\s+/g, " ");
  return res;
}

/**
 * Convert a Markdown string to the HTML subset Telegram supports.
 *
 * Strategy: pull out fenced code blocks and inline code first (their contents
 * must be escaped but NOT interpreted), then escape the remaining text, then
 * apply inline replacements on the now-safe string. Placeholders keep code
 * spans from being touched by the inline rules.
 */
export function markdownToTelegramHtml(md: string): string {
  const codeBlocks: string[] = [];
  const tableBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 0. Clean unrenderable LaTeX math expressions before parsing
  let text = cleanLatexMath(md);

  // 1. Extract fenced code blocks: ```lang\n...\n```
  text = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    const body = escapeHtml(code.replace(/\n$/, ""));
    codeBlocks.push(`<pre>${body}</pre>`);
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });

  // 2. Extract inline code: `...`
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000IC${inlineCodes.length - 1}\u0000`;
  });

  // 2b. Extract Markdown tables → aligned monospace <pre> placeholder (Telegram
  //     has no table support; raw pipes render broken).
  text = extractTables(text, tableBlocks);

  // 2c. Wrap bare filenames in code chips so Telegram doesn't autolink .md/.py as TLDs
  text = text.replace(/(?<![`"'\/a-zA-Z0-9_.-])([a-zA-Z0-9_-]+\.(?:md|py|sh|ts|js|json|yml|yaml|png|jpg|pdf))(?![`"'\/a-zA-Z0-9_.-])/g, (_m, filename: string) => {
    inlineCodes.push(`<code>${escapeHtml(filename)}</code>`);
    return `\u0000IC${inlineCodes.length - 1}\u0000`;
  });

  // 3. Escape everything else so literal <, >, & are safe.
  text = escapeHtml(text);

  // 4. Block-level: headings (#+ ...). Strip inner bold markers so "## **Title**"
  //    becomes <b>Title</b>, NOT <b><b>Title</b></b> — Telegram rejects nested
  //    identical tags and drops ALL formatting for the whole message.
  text = text.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, (_m, h: string) => `<b>${h.replace(/\*\*|__/g, "")}</b>`);

  // 5. Block-level: bullets (*, -, +) → • .
  text = text.replace(/^\s*[*\-+]\s+(.+)$/gm, "• $1");

  // 6. Inline links: [text](url) — url already escaped; keep it usable.
  text = text.replace(/\[([^\]]+)\]\((https?:(?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, label: string, url: string) => {
    const cleanUrl = url.replace(/&amp;/g, "&").replace(/[\]\.,;:]+$/, "");
    return `<a href="${cleanUrl}">${label}</a>`;
  });

  // 6b. Bare bracketed URLs: [https://...] -> <a href="...">...</a>
  text = text.replace(/\[(https?:\/\/[^\]\s]+)\]/g, (_m, url: string) => {
    const cleanUrl = url.replace(/&amp;/g, "&").replace(/[\]\.,;:]+$/, "");
    return `<a href="${cleanUrl}">${cleanUrl}</a>`;
  });

  // 7. Bold: **text** or __text__ .
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_\n]+?)__/g, "<b>$1</b>");

  // 8. Italic: *text* or _text_ (single delimiters; bold already consumed).
  text = text.replace(/(^|[^*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?!\*)/g, "$1<i>$2</i>");
  text = text.replace(/(^|[^\w_])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\w_])/g, "$1<i>$2</i>");

  // 9. Restore placeholders (inline code, tables, code blocks).
  text = text.replace(/\u0000TB(\d+)\u0000/g, (_m, i: string) => tableBlocks[Number(i)]!);
  text = text.replace(/\u0000IC(\d+)\u0000/g, (_m, i: string) => inlineCodes[Number(i)]!);
  text = text.replace(/\u0000CB(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)]!);

  return collapseNestedTags(text);
}

/** True if a line is a Markdown table separator: | --- | :--: | etc. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return /^\|?[\s:|-]+\|?$/.test(t) && t.includes("-") && t.includes("|");
}

/** A table row: trimmed line starts with a pipe and has another pipe after it. */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.includes("|", 1);
}

/** Split a "| a | b |" row into trimmed cell strings. */
function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/**
 * Replace each Markdown table (header + separator + body rows) with a `\u0000TB{n}\u0000`
 * placeholder whose content is a column-aligned, escaped <pre> block.
 */
function extractTables(input: string, store: string[]): string {
  const lines = input.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTableRow(lines[i]!) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows = [lines[i]!];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]!)) rows.push(lines[j++]!);
      store.push(renderTable(rows));
      out.push(`\u0000TB${store.length - 1}\u0000`);
      i = j - 1;
    } else {
      out.push(lines[i]!);
    }
  }
  return out.join("\n");
}

/** Render rows (header + body, no separator) as an aligned, escaped <pre> block. */
function renderTable(rows: string[]): string {
  const cells = rows.map(splitRow);
  const cols = Math.max(...cells.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(...cells.map((r) => (r[c] ?? "").length));
  }
  const lines = cells.map((r) =>
    r.map((cell, c) => (cell ?? "").padEnd(widths[c]!)).join("  ").trimEnd(),
  );
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

/** Collapse immediately-nested identical b/i tags (defence-in-depth). */
function collapseNestedTags(html: string): string {
  let prev: string;
  let cur = html;
  do {
    prev = cur;
    cur = cur
      .replace(/<(b|i)>(\s*)<\1>/g, "<$1>$2")
      .replace(/<\/(b|i)>(\s*)<\/\1>/g, "$2</$1>");
  } while (cur !== prev);
  return cur;
}

/**
 * Split text into chunks no longer than `max`, preferring paragraph then line
 * then word boundaries. A single token longer than `max` is hard-split.
 * Never returns an empty chunk.
 */
export function splitForTelegram(text: string, max: number = TELEGRAM_MAX): string[] {
  if (text.length <= max) {
    const t = text.trim();
    return t ? [t] : [];
  }

  const chunks: string[] = [];
  let buf = "";

  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };

  // Split into lines, keeping the newline as a join hint.
  for (const rawLine of text.split("\n")) {
    const line = rawLine;
    // If a single line is itself too long, break it down by words / hard-split.
    if (line.length > max) {
      flush();
      let rest = line;
      while (rest.length > max) {
        // try to break on the last space before max
        const slice = rest.slice(0, max);
        const lastSpace = slice.lastIndexOf(" ");
        const cut = lastSpace > 0 ? lastSpace : max;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      buf = rest;
      continue;
    }

    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length > max) {
      flush();
      buf = line;
    } else {
      buf = candidate;
    }
  }
  flush();

  return chunks.filter((c) => c.length > 0);
}
