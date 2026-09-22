/**
 * FounderOS — read_logs (self-diagnosis)
 * =====================================
 * Lets FounderOS read its OWN systemd journal. Until this existed the kernel had
 * no instrument for its own runtime at all.
 *
 * THE INCIDENT THIS CLOSES (2026-09-15 19:35, production). The founder asked
 * "read founderOs logs and reason as many bugs as you can". Nothing could read a
 * log line. Rather than reporting the missing instrument, the planner reached for
 * the nearest shaped tool — `project_workflow list_files` against
 * /opt/founderos/apps and /opt/founderos/apps/jarvis, paths retired with v2 on
 * 2026-07-08 — read zero log lines, and emitted a confident "Log & Execution
 * Records Audit Summary" naming services that do not exist. Those fabricated
 * findings were dispatched to an executor as issues #677/#678.
 *
 * So the load-bearing property is NOT "can read logs". It is that a FAILED read
 * can never be narrated as a clean one:
 *   - journalctl exits non-zero        → success:false, stderr surfaced
 *   - the binary is missing            → success:false, the spawn error surfaced
 *   - the window genuinely has nothing → success:true with an explicit `note`
 * An empty result and a broken result are different values, not the same silence.
 *
 * SAFETY
 *   - `unit` is an allowlist, never interpolated — journalctl is spawned with an
 *     argv array, so no shell and nothing to escape.
 *   - Output is capped (MAX_LIMIT) so a whole journal can never reach a model.
 *   - Every line passes through redactSecrets(): prod has leaked env material into
 *     the process table before (2026-08-12), and logs are the same class of risk.
 *   - Read-only, therefore NOT HITL-gated: gating self-diagnosis behind an
 *     approval card is what makes an agent guess instead of look.
 */

import { execFile } from "node:child_process";
import { childLogger } from "../infra/logger.js";
import { redactSecrets } from "../infra/path-guard.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:read-logs" });

/** Units this tool may read. Not interpolated — matched, or refused. */
export const LOG_UNIT_ALLOWLIST = ["founderos.service"] as const;
export type LogUnit = (typeof LOG_UNIT_ALLOWLIST)[number];

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;

/**
 * How many journal lines journalctl is asked to EXAMINE (`-n`), as distinct from
 * how many are RETURNED (the caller's `limit`).
 *
 * Found 2026-09-16 by running this tool against the real journal — the mocked
 * tests could not see it. journalctl applies `-n` before anything here filters,
 * so passing the caller's small limit as `-n` meant a request for "errors in the
 * last 3 days, limit 20" fetched the last 20 lines (in prod: 20 composio
 * upgrade-nag lines), found no errors among them, and reported the window
 * "genuinely empty" while real errors sat just outside the tail. A confident
 * false negative — the exact failure this tool exists to remove.
 */
export const SCAN_CAP = 50_000;

const DEFAULT_SINCE = "1 hour ago";
const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** pino numeric levels. */
const LEVEL_WARN = 40;
const LEVEL_ERROR = 50;

export type LogLevel = "all" | "warn" | "error";

export interface ReadLogsInput {
  since?: string;
  until?: string;
  grep?: string;
  level?: LogLevel;
  limit?: number;
  unit?: string;
}

/** Injected in tests; defaults to spawning journalctl. */
export type JournalRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

/**
 * Build the journalctl argv. Throws on a unit outside the allowlist rather than
 * escaping it — an un-listed unit is a caller bug, not input to sanitise.
 */
export function buildJournalArgs(input: ReadLogsInput): string[] {
  const unit = input.unit ?? LOG_UNIT_ALLOWLIST[0];
  if (!(LOG_UNIT_ALLOWLIST as readonly string[]).includes(unit)) {
    throw new Error(
      `read_logs: unit ${JSON.stringify(unit)} is not in the allowlist (${LOG_UNIT_ALLOWLIST.join(", ")}).`,
    );
  }

  const args = ["-u", unit, "--no-pager", "--since", input.since ?? DEFAULT_SINCE];
  if (input.until) args.push("--until", input.until);
  // SCAN_CAP, never the caller's limit — journalctl applies `-n` before anything
  // here filters. See the SCAN_CAP comment for the false negative that caused.
  args.push("-n", String(SCAN_CAP));
  return args;
}

/** pino level for a journal line, or null when the line is not structured. */
export function parseLevel(line: string): number | null {
  const start = line.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(start)) as { level?: unknown };
    return typeof parsed.level === "number" ? parsed.level : null;
  } catch {
    return null; // allow-failopen: an unparseable line is simply unstructured, not an error
  }
}

/** Structured `module` for a journal line, or null. */
function parseModule(line: string): string | null {
  const start = line.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(start)) as { module?: unknown };
    return typeof parsed.module === "string" ? parsed.module : null;
  } catch {
    return null; // allow-failopen: unstructured line, no module to attribute
  }
}

/**
 * Third-party chatter excluded from the default window.
 *
 * Measured 2026-09-23 on the production journal: 674 of 1,398 lines in 24 hours —
 * 48% — were composio-core's upgrade nag, emitted every ~2 minutes by a
 * dependency. Half the capacity of the only instrument FounderOS has for
 * observing itself, spent on a line nobody reads, and the reason the
 * 2026-09-22 "check production logs" excerpt contained almost no real events.
 *
 * Excluded by DEFAULT, never banned: an explicit `grep` opts back in, and the
 * count is always reported. Silently deleting lines to make a window look clean
 * is the defect this tool exists to prevent.
 */
const NOISE_PATTERNS: readonly RegExp[] = [
  // "2026-09-22T20:58:02.302Z - 🚀 Upgrade available! Your composio-core version …"
  /🚀 Upgrade available! Your \S+ version/,
] as const;

/** True when a line is known third-party chatter with no diagnostic value. */
export function isNoiseLine(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

const MIN_LEVEL: Record<Exclude<LogLevel, "all">, number> = {
  warn: LEVEL_WARN,
  error: LEVEL_ERROR,
};

/**
 * Filter by level and/or substring. A level filter drops unstructured lines: they
 * carry no level, and silently promoting them to "error" would be the same class
 * of guess this tool exists to remove.
 */
export function filterLogLines(lines: string[], opts: { level?: LogLevel; grep?: string } = {}): string[] {
  const needle = opts.grep?.toLowerCase();
  const floor = opts.level && opts.level !== "all" ? MIN_LEVEL[opts.level] : null;

  return lines.filter((line) => {
    if (needle && !line.toLowerCase().includes(needle)) return false;
    if (floor === null) return true;
    const level = parseLevel(line);
    return level !== null && level >= floor;
  });
}

export interface LogSummary {
  total: number;
  errors: number;
  warnings: number;
  byModule: Record<string, number>;
}

/** Counts so the model can reason about shape without re-reading every line. */
export function summarizeLogs(lines: string[]): LogSummary {
  const byModule: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;

  for (const line of lines) {
    const level = parseLevel(line);
    if (level !== null && level >= LEVEL_ERROR) errors++;
    else if (level !== null && level >= LEVEL_WARN) warnings++;
    const mod = parseModule(line);
    if (mod) byModule[mod] = (byModule[mod] ?? 0) + 1;
  }

  return { total: lines.length, errors, warnings, byModule };
}

const defaultRunner: JournalRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "journalctl",
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code === "string") {
          reject(err); // spawn failure (ENOENT): no exit code exists, so it is not a read
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: (err as { code?: number } | null)?.code ?? 0,
        });
      },
    );
  });

/**
 * Read the journal. See the header for why the three outcomes are distinct
 * values rather than one possibly-empty list.
 */
export async function readLogs(
  input: ReadLogsInput,
  run: JournalRunner = defaultRunner,
): Promise<ToolResult> {
  let args: string[];
  try {
    args = buildJournalArgs(input);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await run(args);
  } catch (err) {
    return {
      success: false,
      error: `read_logs could not run journalctl: ${(err as Error).message}. No log lines were read — do not infer runtime behaviour without them.`,
    };
  }

  if (result.code !== 0) {
    return {
      success: false,
      error: `read_logs: journalctl exited ${result.code}: ${result.stderr.trim() || "(no stderr)"}. No log lines were read — do not infer runtime behaviour without them.`,
    };
  }

  const raw = result.stdout.split("\n").filter((l) => l.trim().length > 0);
  // An explicit grep opts back in — asking for the nag must still find it.
  const signal = input.grep ? raw : raw.filter((l) => !isNoiseLine(l));
  const noise = raw.length - signal.length;
  const filtered = filterLogLines(signal, { level: input.level, grep: input.grep });
  const capped = filtered.slice(-clampLimit(input.limit));
  const { redacted, count } = redactSecrets(capped.join("\n"));
  const lines = redacted.length > 0 ? redacted.split("\n") : [];

  if (count > 0) log.warn({ count }, "read_logs redacted secret-shaped values from journal output");

  /**
   * Summarize `filtered` — every line that MATCHED — not `lines`, the tail that
   * fits the caller's limit.
   *
   * 2026-09-22, production: the founder asked to check the logs. The 1-hour
   * window held 66 lines with 5 warnings; the returned last-50 slice held 1.
   * Counting the slice reported "0 errors, 1 warning" and FounderOS answered
   * "Healthy / Fully Operational". Four warnings existed and were described as
   * absent — the same confident false negative SCAN_CAP was introduced to kill,
   * surviving one layer further down.
   *
   * The excerpt stays capped; only the arithmetic moved to the evidence.
   */
  const summary = summarizeLogs(filtered);
  const withheld = filtered.length - lines.length;

  // Distinguishable states, never one ambiguous silence: found something /
  // genuinely empty / incomplete window. A window is incomplete for EITHER
  // reason — the journalctl scan ceiling, or the caller's limit withholding
  // matched lines — and both have to reach the model, because "here is
  // everything" and "here is the tail of it" support different conclusions.
  const ceilingHit = raw.length >= SCAN_CAP;
  const truncated = ceilingHit || withheld > 0;
  const where = `unit=${input.unit ?? LOG_UNIT_ALLOWLIST[0]}, since=${input.since ?? DEFAULT_SINCE}${input.grep ? `, grep=${input.grep}` : ""}`;

  const noiseNote = noise > 0 ? ` ${noise} third-party upgrade-notice line(s) were excluded from this window; grep for them explicitly to see them.` : "";

  let note: string;
  if (filtered.length === 0 && ceilingHit) {
    note =
      `No matching log lines among the ${raw.length} scanned (${where}) — but the ${SCAN_CAP}-line scan ceiling was reached, ` +
      `so this window is TRUNCATED and matches may exist outside it. Narrow since/until and read again before concluding anything.` + noiseNote;
  } else if (filtered.length === 0) {
    note =
      `No matching log lines in this window (${where}). The read SUCCEEDED and the window is genuinely empty — ` +
      `widen 'since' before concluding anything.` + noiseNote;
  } else {
    note =
      `${filtered.length} line(s) matched in this window (${summary.errors} error, ${summary.warnings} warn) — ` +
      `counts are for the WHOLE window, not just the excerpt below.` +
      (withheld > 0
        ? ` Showing the newest ${lines.length}; ${withheld} older matching line(s) were withheld by limit=${clampLimit(input.limit)} ` +
          `and are NOT in the excerpt — raise 'limit' or narrow 'since' before quoting the excerpt as complete.`
        : "") +
      (ceilingHit ? ` Scan ceiling (${SCAN_CAP}) reached — older lines in this window were NOT examined.` : "") +
      noiseNote;
  }

  return {
    success: true,
    data: {
      lines,
      summary,
      note,
      scanned: raw.length,
      matched: filtered.length,
      noise,
      returned: lines.length,
      withheld,
      truncated,
      redacted: count,
    },
  };
}

export const readLogsTool: UnifiedTool = {
  name: "read_logs",
  description:
    "Read FounderOS's OWN production logs (systemd journal for founderos.service). This is the ONLY way to observe what the running system actually did. " +
    "Use it before diagnosing ANY runtime behaviour, bug report, failure or 'why did X happen' question — never infer runtime behaviour from the filesystem, " +
    "from directory listings, or from memory. Filter with level='error' to find failures fast, or grep for a module/turnId. " +
    "If this tool returns success:false you have NO log evidence: say so plainly and stop — do not substitute another tool and do not describe behaviour you did not observe. " +
    "State error/warning counts from `summary` and `matched`, NEVER by counting the `lines` excerpt: `lines` holds the newest `returned` of `matched`, and `withheld` older matching lines are absent from it. " +
    "When `truncated` is true you are holding an excerpt, not the window — never call the system healthy, clean or error-free from it.",
  input_schema: {
    type: "object",
    properties: {
      since: { type: "string", description: "Window start, journalctl syntax: '1 hour ago', '2 days ago', '2026-09-15'. Default '1 hour ago'." },
      until: { type: "string", description: "Window end, same syntax. Optional." },
      level: { type: "string", enum: ["all", "warn", "error"], description: "'error' = pino level >= 50, 'warn' >= 40. Default 'all'." },
      grep: { type: "string", description: "Case-insensitive substring filter (module name, turnId, message text)." },
      limit: { type: "number", description: `Max lines returned (default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}).` },
      unit: { type: "string", description: `systemd unit. Allowlisted: ${LOG_UNIT_ALLOWLIST.join(", ")}.` },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    return readLogs({
      since: args["since"] as string | undefined,
      until: args["until"] as string | undefined,
      grep: args["grep"] as string | undefined,
      level: args["level"] as LogLevel | undefined,
      limit: args["limit"] as number | undefined,
      unit: args["unit"] as string | undefined,
    });
  },
};
