/**
 * FounderOS — goals: the /goal command grammar (pure)
 * ===================================================
 *   /goal add <title> | metric=<key>[:<arg>] target=<n> [by=YYYY-MM-DD] [baseline=<n>] [priority=<n>]
 *   /goal <n> <value>            report a value for a `manual` goal
 *   /goal done|drop|unblock <n>
 *   /goal block <n> <reason> [until=YYYY-MM-DD]
 *
 * `<n>` is the 1-based position in the ordered open list (priority, then created_at), the same
 * numbers `/goals` prints. The rule this file exists to hold: a missing or invalid field is NAMED with
 * what to write instead, every problem at once, and nothing is guessed (fix the schema, not the code).
 * Where the options are finite (which metric key, which profile, which repo) the issue carries a
 * `choices` request and the gateway turns it into buttons.
 *
 * No regex on the founder's text: it is split on whitespace and `=`, and each value is checked by a
 * function that says what is wrong with it.
 */

import { addDays, isValidDateKey } from "./local-date.js";
import { MAX_GOAL_VALUE, formatNumber, parseUserNumber } from "./numeric.js";
import { METRICS, METRIC_KEYS, isMetricKey, type MetricKey } from "./metrics.js";
import { isRepoSlug, isSafeToken } from "./tokens.js";

export const MAX_TITLE_CHARS = 120;
export const MAX_REASON_CHARS = 200;
export const MAX_PRIORITY = 1000;
/** Default list position: below anything the founder ranks explicitly with priority=. */
export const DEFAULT_PRIORITY = 100;
/** Highest goal number accepted; an absurd one is a typo, not a request. */
const MAX_GOAL_NUMBER = 100_000;

export interface GoalDraft {
  readonly title: string;
  readonly metricKey: MetricKey;
  readonly metricArg: string | null;
  readonly target: number;
  readonly baseline: number;
  readonly dueOn: string | null;
  readonly priority: number;
}

export type GoalCommand =
  | { readonly kind: "usage" }
  | { readonly kind: "add"; readonly draft: GoalDraft }
  | { readonly kind: "set-value"; readonly n: number; readonly value: number }
  | { readonly kind: "done" | "drop" | "unblock"; readonly n: number }
  | { readonly kind: "block"; readonly n: number; readonly reason: string; readonly until: string | null };

/** A finite set the founder can choose from with buttons. */
export type ChoiceRequest = { readonly kind: "metric-family" } | { readonly kind: "metric-arg"; readonly family: MetricKey };

export interface ParseIssue {
  /** The exact field at fault: `title`, `metric`, `target`, `by`, `n`, `reason`, or the unknown word itself. */
  readonly field: string;
  readonly message: string;
  readonly choices?: ChoiceRequest;
}

export type ParseResult =
  | { readonly ok: true; readonly command: GoalCommand }
  | { readonly ok: false; readonly issues: readonly ParseIssue[] };

export interface ParseContext {
  /** Today's local date, `YYYY-MM-DD`. */
  readonly today: string;
  /** A profile id, or a friendly word for one (`tashi`), → the canonical id; null when it is neither. */
  readonly resolveProfile: (token: string) => string | null;
  /** A metric supplied by a button tap: it replaces whatever `metric=` said, or fills the gap. */
  readonly metricOverride?: string;
}

const ADD_OPTIONS = ["metric", "target", "by", "baseline", "priority"] as const;
const FIELD_ORDER: readonly string[] = ["title", ...ADD_OPTIONS];
const VERBS = "add, done, drop, block, unblock, or /goal <n> <value>";

const ok = (command: GoalCommand): ParseResult => ({ ok: true, command });
const refuse = (issues: readonly ParseIssue[]): ParseResult => ({ ok: false, issues });

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isAllDigits = (s: string): boolean => s.length > 0 && [...s].every((c) => c >= "0" && c <= "9");

/** Whitespace-separated words. */
function words(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of text) {
    if (isSpace(ch)) {
      if (current) out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** A founder-typed token shortened for echoing back in a message. */
const echo = (text: string, max = 30): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function parseGoalNumber(token: string | undefined): { n: number } | { issue: ParseIssue } {
  if (token === undefined) {
    return { issue: { field: "n", message: "which goal? Send its number from /goals, e.g. /goal done 2." } };
  }
  if (!isAllDigits(token) || Number(token) > MAX_GOAL_NUMBER) {
    return { issue: { field: "n", message: `'${echo(token)}' is not a goal number. Use the number /goals shows next to the goal.` } };
  }
  const n = Number(token);
  return n === 0 ? { issue: { field: "n", message: "goal numbers start at 1. Use the number /goals shows next to the goal." } } : { n };
}

/** `key` or `key:arg` → a validated metric, or the issue that says what to write. */
export function parseMetricSpec(
  spec: string,
  ctx: Pick<ParseContext, "resolveProfile">,
): { ok: true; key: MetricKey; arg: string | null } | { ok: false; issue: ParseIssue } {
  const colon = spec.indexOf(":");
  const keyText = (colon === -1 ? spec : spec.slice(0, colon)).toLowerCase();
  const argText = colon === -1 ? null : spec.slice(colon + 1);
  const bad = (message: string, choices?: ChoiceRequest) => ({
    ok: false as const,
    issue: { field: "metric", message, ...(choices ? { choices } : {}) },
  });

  if (!isMetricKey(keyText)) {
    return bad(`'${echo(keyText)}' is not a metric. Valid keys: ${METRIC_KEYS.join(", ")}.`, { kind: "metric-family" });
  }
  const def = METRICS[keyText];
  if (def.arg === null) {
    return argText === null ? { ok: true, key: keyText, arg: null } : bad(`${keyText} takes no argument. Write metric=${keyText}.`);
  }

  const asks = { profile: "a profile", repo: "a repo", action: "an action name" }[def.arg];
  const shape = { profile: "<profile_id>", repo: "<owner/repo>", action: "<action>" }[def.arg];
  const choices: ChoiceRequest | undefined = def.arg === "action" ? undefined : { kind: "metric-arg", family: keyText };
  if (argText === null || argText === "") return bad(`${keyText} needs ${asks}: metric=${keyText}:${shape}.`, choices);

  if (def.arg === "profile") {
    const resolved = ctx.resolveProfile(argText);
    return resolved === null ? bad(`'${echo(argText)}' is not a known profile. Pick one below.`, choices) : { ok: true, key: keyText, arg: resolved };
  }
  const valid = def.arg === "repo" ? isRepoSlug(argText) : isSafeToken(argText);
  if (!valid) {
    return bad(
      def.arg === "repo"
        ? `'${echo(argText)}' is not an owner/repo (letters, digits, . _ - only, one slash).`
        : `'${echo(argText)}' is not a plain action name (letters, digits, . _ - only).`,
      choices,
    );
  }
  return { ok: true, key: keyText, arg: argText };
}

function checkDate(value: string, field: "by" | "until", today: string): ParseIssue | null {
  if (!isValidDateKey(value)) {
    return { field, message: `${field} '${echo(value)}' is not a date. Write it as YYYY-MM-DD, e.g. ${field}=${addDays(today, 30)}.` };
  }
  if (field === "by" && value < today) return { field, message: `by ${value} is already in the past (today is ${today}).` };
  if (field === "until" && value <= today) {
    return { field, message: `until ${value} must be after today (${today}): a block that has already ended blocks nothing.` };
  }
  return null;
}

function checkNumber(field: string, raw: string, opts: { min: number; minInclusive: boolean; hint: string }): { value: number } | { issue: ParseIssue } {
  const value = parseUserNumber(raw);
  if (value === null) return { issue: { field, message: `${field} '${echo(raw)}' is not a number. Write a plain number like ${opts.hint} (no commas).` } };
  if (Math.abs(value) > MAX_GOAL_VALUE) return { issue: { field, message: `${field} is too large: the limit is ${formatNumber(MAX_GOAL_VALUE)}.` } };
  const tooLow = opts.minInclusive ? value < opts.min : value <= opts.min;
  if (tooLow) return { issue: { field, message: `${field} must be ${opts.minInclusive ? `${opts.min} or more` : `greater than ${opts.min}`} (got ${formatNumber(value)}).` } };
  return { value };
}

function parseAdd(rest: string, ctx: ParseContext): ParseResult {
  const bar = rest.lastIndexOf("|");
  if (bar === -1) {
    return refuse([
      {
        field: "separator",
        message: "put a | between the title and its options, e.g. /goal add Ship one fix a week | metric=prs_merged_7d:owner/repo target=1 by=2026-10-31.",
      },
    ]);
  }
  const issues: ParseIssue[] = [];
  const title = rest.slice(0, bar).trim();
  if (title === "") issues.push({ field: "title", message: "title is missing. Write it before the |, e.g. /goal add Ship one fix a week | metric=…" });
  else if (title.length > MAX_TITLE_CHARS) issues.push({ field: "title", message: `title is ${title.length} characters; the limit is ${MAX_TITLE_CHARS}.` });

  const options = new Map<string, string>();
  for (const word of words(rest.slice(bar + 1))) {
    const eq = word.indexOf("=");
    const key = (eq === -1 ? word : word.slice(0, eq)).toLowerCase();
    if (eq === -1) {
      issues.push({ field: echo(word), message: `'${echo(word)}' is not key=value. Options are ${ADD_OPTIONS.join(", ")}, each written like target=5.` });
    } else if (!(ADD_OPTIONS as readonly string[]).includes(key)) {
      issues.push({ field: echo(key), message: `unknown option '${echo(key)}'. Valid options: ${ADD_OPTIONS.join(", ")}.` });
    } else if (options.has(key)) {
      issues.push({ field: key, message: `'${key}' was given twice; keep one.` });
    } else options.set(key, word.slice(eq + 1));
  }

  const spec = ctx.metricOverride ?? options.get("metric");
  let metric: { key: MetricKey; arg: string | null } | undefined;
  if (spec === undefined || spec === "") {
    issues.push({ field: "metric", message: "metric is missing: which number measures this goal? Pick one below.", choices: { kind: "metric-family" } });
  } else {
    const parsed = parseMetricSpec(spec, ctx);
    if (parsed.ok) metric = parsed;
    else issues.push(parsed.issue);
  }

  let target = 0;
  const targetText = options.get("target");
  if (targetText === undefined || targetText === "") issues.push({ field: "target", message: "target is missing: the number to reach, e.g. target=5." });
  else {
    const t = checkNumber("target", targetText, { min: 0, minInclusive: false, hint: "5 or 2.5" });
    if ("issue" in t) issues.push(t.issue);
    else target = t.value;
  }

  const byText = options.get("by");
  const dueOn = byText === undefined || byText === "" ? null : byText;
  if (byText === "") issues.push({ field: "by", message: "by is empty. Write a date like by=2026-10-31, or leave it out for no deadline." });
  else if (dueOn !== null) {
    const issue = checkDate(dueOn, "by", ctx.today);
    if (issue) issues.push(issue);
  }

  let baseline = 0;
  const baselineText = options.get("baseline");
  if (baselineText !== undefined) {
    const b = checkNumber("baseline", baselineText, { min: 0, minInclusive: true, hint: "0 or 1200" });
    if ("issue" in b) issues.push(b.issue);
    else baseline = b.value;
  }

  let priority = DEFAULT_PRIORITY;
  const priorityText = options.get("priority");
  if (priorityText !== undefined) {
    const p = checkNumber("priority", priorityText, { min: 1, minInclusive: true, hint: "10" });
    if ("issue" in p) issues.push(p.issue);
    else if (!Number.isInteger(p.value) || p.value > MAX_PRIORITY) {
      issues.push({ field: "priority", message: `priority must be a whole number from 1 to ${MAX_PRIORITY} (1 lists first).` });
    } else priority = p.value;
  }

  if (issues.length > 0 || metric === undefined) {
    const rank = (i: ParseIssue): number => (FIELD_ORDER.includes(i.field) ? FIELD_ORDER.indexOf(i.field) : FIELD_ORDER.length);
    return refuse(issues.map((issue, index) => ({ issue, index })).sort((a, b) => rank(a.issue) - rank(b.issue) || a.index - b.index).map((e) => e.issue));
  }
  return ok({ kind: "add", draft: { title, metricKey: metric.key, metricArg: metric.arg, target, baseline, dueOn, priority } });
}

function parseSetValue(nToken: string, rest: string): ParseResult {
  const issues: ParseIssue[] = [];
  const n = parseGoalNumber(nToken);
  if ("issue" in n) issues.push(n.issue);
  const [valueToken, ...extra] = words(rest);
  let value = 0;
  if (valueToken === undefined) issues.push({ field: "value", message: "value is missing: the number to record, e.g. /goal 2 1200." });
  else {
    const v = checkNumber("value", valueToken, { min: -MAX_GOAL_VALUE, minInclusive: true, hint: "1200 or 2.5" });
    if ("issue" in v) issues.push(v.issue);
    else value = v.value;
  }
  if (extra.length > 0) issues.push({ field: "extra", message: `after the value I found '${echo(extra[0] ?? "")}'. Send just the number: /goal ${nToken} 1200.` });
  return issues.length > 0 || "issue" in n ? refuse(issues) : ok({ kind: "set-value", n: n.n, value });
}

function parseIndexVerb(kind: "done" | "drop" | "unblock", rest: string): ParseResult {
  const [token, ...extra] = words(rest);
  const n = parseGoalNumber(token);
  if ("issue" in n) return refuse([n.issue]);
  if (extra.length > 0) return refuse([{ field: "extra", message: `after the number I found '${echo(extra[0] ?? "")}'. Send just: /goal ${kind} ${n.n}.` }]);
  return ok({ kind, n: n.n });
}

function parseBlock(rest: string, ctx: ParseContext): ParseResult {
  const [token, ...tail] = words(rest);
  const n = parseGoalNumber(token);
  if ("issue" in n) return refuse([n.issue]);
  const issues: ParseIssue[] = [];
  const reasonWords: string[] = [];
  let until: string | null = null;
  for (const word of tail) {
    if (word.toLowerCase().startsWith("until=")) {
      const value = word.slice("until=".length);
      const issue = checkDate(value, "until", ctx.today);
      if (issue) issues.push(issue);
      else until = value;
    } else reasonWords.push(word);
  }
  const reason = reasonWords.join(" ");
  if (reason === "") issues.push({ field: "reason", message: "reason is missing: say what you are waiting on, e.g. /goal block 2 waiting on the visa decision until=2026-10-15." });
  else if (reason.length > MAX_REASON_CHARS) issues.push({ field: "reason", message: `reason is ${reason.length} characters; the limit is ${MAX_REASON_CHARS}.` });
  return issues.length > 0 ? refuse(issues) : ok({ kind: "block", n: n.n, reason, until });
}

/** Parse everything after `/goal`. */
export function parseGoalCommand(rawArgs: string, ctx: ParseContext): ParseResult {
  const text = rawArgs.trim();
  if (text === "") return ok({ kind: "usage" });
  const verbToken = words(text)[0] ?? "";
  const rest = text.slice(verbToken.length).trim();
  switch (verbToken.toLowerCase()) {
    case "add":
      return parseAdd(rest, ctx);
    case "done":
    case "drop":
    case "unblock":
      return parseIndexVerb(verbToken.toLowerCase() as "done" | "drop" | "unblock", rest);
    case "block":
      return parseBlock(rest, ctx);
    default:
      return isAllDigits(verbToken)
        ? parseSetValue(verbToken, rest)
        : refuse([{ field: "command", message: `'${echo(verbToken)}' is not a /goal command. Use ${VERBS}.` }]);
  }
}

/**
 * The arguments of a `/goal …` message, read back from its text (the metric buttons re-parse the
 * founder's original message). Null when the text is not a /goal command: `/goals` is not.
 */
export function goalArgsOf(messageText: string): string | null {
  const text = messageText.trim();
  const first = words(text)[0] ?? "";
  const name = first.split("@")[0] ?? "";
  return name.toLowerCase() === "/goal" ? text.slice(first.length).trim() : null;
}
