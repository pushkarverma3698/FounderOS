/**
 * FounderOS — Telegram rendering primitives
 * =========================================
 * The small, dangerous parts of putting text on a phone screen: escaping,
 * length limits, and links. Separated from brief.ts so the layout stays about
 * layout, and so these can be tested against Telegram's actual rules rather
 * than against a brief.
 *
 * THE ESCAPING RULE THAT MATTERS. Escaping used to happen at the transport —
 * `toTelegramSafe(await buildDailyBrief(...))` — which was correct only while
 * the brief contained no markup of its own. The moment the brief emits <b> to
 * be readable, a whole-message escape prints "&lt;b&gt;" at the founder instead
 * of bolding anything.
 *
 * So escaping moved INWARD, to the leaf. Every value that came from a company,
 * a job title, or a gate's evidence string goes through `esc()` at the point it
 * is interpolated; the markup around it is written by us and is trusted by
 * construction. The transport now sends the rendered string unchanged.
 */

/** Telegram rejects a sendMessage body over this length outright. */
export const TELEGRAM_MAX_CHARS = 4096;

/**
 * Escape a value for Telegram's HTML parse mode.
 *
 * Telegram rejects the ENTIRE message when it cannot parse the entities, and the
 * brief's fallback path re-sends with the same parse mode — so one unescaped "&"
 * in a company name means the founder receives nothing while the sweep logs
 * success. "Bloom & Wild Group" arrived in the 2026-07-31 production sweep and
 * would have done exactly that.
 *
 * Ampersand is escaped first; escaping it later would turn "&lt;" into
 * "&amp;lt;" and print the escape instead of the character.
 */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Retained name for the whole-message escape.
 *
 * Still correct for plain-text alerts that carry no markup — the sweep's
 * "everything failed" path builds a bare string out of error messages, and those
 * genuinely are all data. It must NOT be used on the rendered brief.
 */
export const toTelegramSafe = esc;

/**
 * A label linked to the posting, or the bare label when there is no URL.
 *
 * The URL is checked rather than trusted. It arrives from a job feed, and an
 * unparseable or non-http href makes Telegram reject the message — turning a
 * malformed link on one row into a lost brief. A row with a bad URL should lose
 * its link, not the founder's morning.
 */
export function link(label: string, url: string | null): string {
  const safeLabel = esc(label);
  if (!url) return safeLabel;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return safeLabel;
    return `<a href="${esc(parsed.toString())}">${safeLabel}</a>`;
  } catch {
    return safeLabel;
  }
}

/**
 * A tap-to-copy command chip.
 *
 * `<code>` is not decoration: on both Telegram mobile clients tapping a code
 * span copies it, so the founder runs `/draft 2` without typing or mistyping it.
 * That is the difference between the brief ENDING in an action and merely
 * describing one.
 */
export function cmd(command: string): string {
  return `<code>${esc(command)}</code>`;
}

/**
 * Split a rendered message into Telegram-sized parts, never mid-tag.
 *
 * Nothing in the send path chunks, so before this existed a brief over 4,096
 * characters was rejected whole and the founder got silence — a failure that
 * would arrive precisely when the pipeline finally had enough supply to be worth
 * reading, and would look like the sweep having found nothing.
 *
 * Splitting is on LINE boundaries, and every tag this module emits opens and
 * closes within a single line, so a part can never end inside an entity.
 * Paragraph boundaries are preferred so sections stay whole where they fit.
 */
export function splitForTelegram(
  text: string,
  max: number = TELEGRAM_MAX_CHARS,
): string[] {
  if (text.length <= max) return [text];

  const parts: string[] = [];
  let current = "";

  for (const block of text.split("\n\n")) {
    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      parts.push(current);
      current = "";
    }
    // A single block over the limit still has to go somewhere: fall back to
    // line-by-line, which is the finest cut that remains tag-safe.
    if (block.length <= max) {
      current = block;
      continue;
    }
    for (const line of block.split("\n")) {
      const lineCandidate = current.length === 0 ? line : `${current}\n${line}`;
      if (lineCandidate.length <= max) {
        current = lineCandidate;
        continue;
      }
      if (current.length > 0) parts.push(current);
      // A single line longer than the limit is not something this brief can
      // produce (every field is trimmed upstream), but truncating loudly beats
      // throwing away the rest of the message.
      current = line.length <= max ? line : `${line.slice(0, max - 1)}…`;
    }
  }

  if (current.length > 0) parts.push(current);
  return parts;
}
