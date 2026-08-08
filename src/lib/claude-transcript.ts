/**
 * FounderOS — Claude Code session distillation
 * =============================================
 * Turns a `~/.claude/projects/<slug>/<session>.jsonl` transcript into the small
 * part of it worth remembering.
 *
 * WHY SUBTRACTIVE: the transcripts are 358 MB (213 MB for this repo alone, one
 * session file at 79 MB). Almost all of that is tool_use inputs and tool_result
 * payloads — file contents that are already in git, re-embedded as prose. Loading
 * it into pgvector would bury the curated brain chunks under a corpus of my own
 * echo, and retrieval quality would fall. The founder's instruction (2026-08-07)
 * was explicit: no raw transcripts.
 *
 * So this keeps two things — what the founder said, and what was concluded — and
 * discards everything else, including `thinking` blocks (reasoning en route to an
 * answer is not the answer).
 *
 * Pure: no filesystem, no network, no database. The caller supplies the text.
 */

/** A single kept exchange. `thinking`, `tool_use` and `tool_result` never appear here. */
export interface DistilledTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface DistilledSession {
  readonly sessionId: string;
  readonly turns: readonly DistilledTurn[];
  /** Timestamp of the last kept turn — lets ingestion skip unchanged sessions. */
  readonly lastActivity: Date | null;
  /**
   * Lines that would not parse. A live session is always mid-write, so a
   * truncated final line is expected and harmless — but a file that is mostly
   * unparseable is a format change, and the count is how the caller notices.
   */
  readonly malformedLines: number;
}

/** Content blocks worth keeping. Everything else is machinery. */
const KEPT_BLOCK_TYPE = "text";

/** Below this, a "turn" is an acknowledgement, not content. */
const MIN_TURN_CHARS = 12;

/**
 * Above this, a "turn" is a paste, not a message.
 *
 * Measured over 1,228 real founder turns: median 245 chars, p75 2,884, p90 13,753
 * — and a single maximum of 8,433,701. The mean is meaningless; a handful of giant
 * pastes (a whole file, a long log) carry almost all the bytes and almost none of
 * the meaning, since the pasted thing is usually already in git. Truncating at
 * p75-plus keeps every real message whole and clips only the pastes.
 */
const MAX_TURN_CHARS = 4000;

/**
 * Slash-command plumbing that Claude Code writes into `user` lines.
 *
 * 323 of 5,379 turns are these: the stdout of a local command and the caveat
 * block warning that it was machine-generated rather than typed. Ingesting them
 * would store command output as though the founder had said it.
 */
const COMMAND_OUTPUT_MARKERS = ["local-command-stdout", "local-command-caveat"] as const;

interface RawLine {
  type?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/**
 * Pull the prose out of one message's content, which Claude Code writes either
 * as a bare string (user turns) or as a block list (assistant turns, and user
 * turns that carry tool results).
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === KEPT_BLOCK_TYPE &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Distil one session transcript.
 *
 * Only `user` and `assistant` lines are considered. `queue-operation`,
 * `attachment`, `system` and `last-prompt` are transport bookkeeping — several
 * of them duplicate the prompt text verbatim, so keeping them would triple-count
 * every message the founder sent.
 */
export function distillSession(jsonlText: string, sessionId: string): DistilledSession {
  const turns: DistilledTurn[] = [];
  let lastActivity: Date | null = null;
  let malformedLines = 0;

  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let raw: RawLine;
    try {
      raw = JSON.parse(trimmed) as RawLine;
    } catch {
      malformedLines += 1;
      continue;
    }

    if (raw.type !== "user" && raw.type !== "assistant") continue;

    const text = extractText(raw.message?.content);
    if (text.length < MIN_TURN_CHARS) continue;
    if (COMMAND_OUTPUT_MARKERS.some((marker) => text.includes(marker))) continue;

    turns.push({
      role: raw.type,
      text: text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}\n…[truncated]` : text,
    });

    const at = parseTimestamp(raw.timestamp);
    if (at && (lastActivity === null || at > lastActivity)) lastActivity = at;
  }

  return { sessionId, turns, lastActivity, malformedLines };
}

/**
 * The text that actually gets chunked and embedded.
 *
 * Speakers are labelled because a chunk is retrieved alone, with no surrounding
 * session — an unattributed paragraph reads as fact when it may have been a
 * proposal the founder rejected two turns later.
 */
export function renderSession(session: DistilledSession): string {
  if (session.turns.length === 0) return "";

  return session.turns
    .map((turn) => `${turn.role === "user" ? "FOUNDER" : "CLAUDE"}: ${turn.text}`)
    .join("\n\n");
}
