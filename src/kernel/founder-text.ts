/**
 * FounderOS v3 kernel — founder-facing text redaction.
 * ====================================================
 * The internal/external boundary for reply text. Everything the kernel records
 * for verification (tool names, args hashes, result digests, absolute artifact
 * paths) stays exactly where it is — in `tool_receipts`, the trace, and the
 * logs. This module governs only what the FOUNDER reads.
 *
 * Why code and not a prompt: the synthesizer is an LLM, and "please don't
 * mention the file path" is an instruction it can drop under load. Redaction
 * that must hold every turn belongs in a pure function, same as routing and
 * parsing (see CLAUDE.md — determinism).
 *
 * Scope is deliberately narrow: absolute filesystem paths. A path is the one
 * internal detail the synthesizer reproduces verbatim, because `write_artifact`
 * must return it so `deliver_artifact` can chain off it.
 */

/**
 * Absolute POSIX paths of two or more segments.
 *
 * The lookbehind is what keeps URLs intact: in `https://github.com/a/b` the
 * first slash is preceded by `:` and the second by `/`, so neither can open a
 * match, and the remainder has no leading slash. `24/7` and `and/or` never
 * match either — they have no leading slash.
 */
const ABSOLUTE_PATH = /(?<![\w:/])\/(?:[\w.@+-]+\/)+[\w.@+-]+/g;

/** Last segment of a POSIX path. */
function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

/**
 * Replace absolute filesystem paths with their filename.
 *
 * `/opt/founderos/artifacts/jobs_export.csv` → `jobs_export.csv`
 *
 * The founder still learns WHICH file — the part they can act on — without the
 * server layout, which tells them nothing and scores as leakage.
 */
export function redactInternalPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, (match) => basename(match));
}

/**
 * snake_case tokens — `job_state`, `write_artifact`, `action_log`, `applied_at`.
 *
 * English does not put underscores inside words, so a snake_case token in
 * founder-facing prose is always an identifier that leaked out of the machine:
 * a tool name, a table, a column. Requiring two or more letters per segment
 * keeps it off things like `a_b`.
 */
const SNAKE_CASE_IDENTIFIER = /\b[a-z]{2,}(?:_[a-z0-9]{2,})+\b/g;

/**
 * Drop internal identifiers from a short founder-facing label.
 *
 * Deliberately NOT applied to synthesized replies. In a reply the founder may
 * have asked about a column by name, and a blanket substitution would delete
 * the answer. In a progress label — one throwaway line naming what is happening
 * right now — an identifier is never the point, and the planner routinely writes
 * them into step objectives. Proven on prod 2026-08-14: the `turn.progress`
 * seam emitted `🔧 jobhunt: Retrieve the full set of captured jobs using
 * job_state and …`, leaking both a worker id and a tool name in one line.
 */
export function redactInternalIdentifiers(text: string): string {
  return text.replace(SNAKE_CASE_IDENTIFIER, "").replace(/\s{2,}/g, " ").trim();
}
