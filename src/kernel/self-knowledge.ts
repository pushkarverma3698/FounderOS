/**
 * FounderOS v3 kernel — self-knowledge from the registry.
 * ========================================================
 * "What can you do", "list your tools by department", "can you send email" are answered by
 * pure code from the worker tool lists the kernel was built with (the same arrays the worker
 * binds), never by the model. A model asked what it can do answers from memory and adds
 * departments and tools that are not registered: answer_evaluations 2026-09-29, groundedness
 * 50/100, "List all tools available in FounderOS by department" (audit item P2-5,
 * docs/plans/2026-10-04-telegram-ux-audit.md).
 *
 * The reply holds only registry names, the department ids the registry declares, and fixed
 * sentences. Recognition is deliberately narrow: a question that is really a request
 * ("can you email john about the invoice") returns null and goes to the planner. When this
 * module cannot tell, it says nothing — the failure direction is "the model answers as before",
 * never "a wrong canned answer".
 */

export interface SelfKnowledgeDepartment {
  readonly id: string;
  readonly toolNames: readonly string[];
}

/** A longer message is a task that happens to contain a trigger phrase, not a self-knowledge question. */
export const SELF_KNOWLEDGE_MAX_WORDS = 14;

/** A capability question names at most this many content words ("can you send email" is 2). */
export const CAPABILITY_MAX_CONTENT_WORDS = 4;

/** Tools named in one "yes" answer before the rest are summarised as a count. */
export const CAPABILITY_MAX_TOOLS_LISTED = 10;

/** Phrases that ask for the whole picture. Must end the message (bar TAIL words). */
const LIST_PHRASES: readonly (readonly string[])[] = [
  ["what", "can", "you", "do"],
  ["what", "do", "you", "do"],
  ["what", "can", "founderos", "do"],
  ["what", "can", "i", "ask", "you"],
  ["what", "are", "you", "capable", "of"],
  ["what", "are", "your", "capabilities"],
  ["what", "are", "your", "features"],
  ["what", "are", "your", "tools"],
  ["what", "are", "your", "skills"],
];
const LIST_TAIL: ReadonlySet<string> = new Set(["for", "me", "here", "now", "today", "exactly", "really", "actually", "right"]);

/** "list/show … tools" needs one of each: a thing listed, a cue to list it, and a sign it is about me. */
const LIST_NOUNS: ReadonlySet<string> = new Set(["tool", "tools", "capabilities", "capability", "departments", "department", "features", "skills", "integrations"]);
const LIST_CUES: ReadonlySet<string> = new Set(["list", "show", "enumerate", "display", "which", "what", "all", "every"]);
const SELF_CUES: ReadonlySet<string> = new Set(["you", "your", "founderos", "available", "have", "department", "departments"]);
/** Past-tense or history words: "what tools did you use yesterday" is a question about a turn, not the registry. */
const ACTIVITY: ReadonlySet<string> = new Set(["did", "used", "ran", "failed", "called", "yesterday", "last", "earlier", "before", "was", "were", "broke", "wrong"]);
/** A department may be named by its id or by the word the founder uses. */
const DEPARTMENT_ALIASES: Readonly<Record<string, string>> = { jobs: "jobhunt", job: "jobhunt" };

/** How a capability question opens. */
const OPENERS: readonly (readonly string[])[] = [
  ["can", "you"],
  ["could", "you"],
  ["are", "you", "able", "to"],
  ["do", "you", "have"],
  ["do", "you", "support"],
];
const FILLER: ReadonlySet<string> = new Set([
  "a", "an", "the", "any", "to", "for", "with", "my", "our", "your", "me", "also", "even", "really",
  "tool", "tools", "integration", "integrations", "access", "ability", "support", "use", "using", "via", "on", "in", "of", "up",
]);
/** Verbs a tool name can start with, or a founder can ask for. Everything else is a thing (a noun). */
const ACTION_VERBS: ReadonlySet<string> = new Set([
  "send", "post", "publish", "schedule", "tweet", "text", "call", "message", "book", "pay", "buy", "order", "deploy", "upload",
  "delete", "read", "write", "create", "run", "search", "list", "get", "show", "set", "update", "edit", "check", "draft", "make",
  "find", "scrape", "crawl", "generate", "track", "remind",
]);
/** Verbs that act outside the building: "can you X" about one of these with no matching tool is a firm no. */
const EXTERNAL_VERBS: ReadonlySet<string> = new Set([
  "send", "post", "publish", "schedule", "tweet", "text", "call", "message", "book", "pay", "buy", "order", "deploy", "upload", "delete",
]);
const EXPLICIT_TOOL_WORDS: ReadonlySet<string> = new Set(["tool", "tools", "integration", "integrations"]);

/** Lowercase alphanumeric words; every other character separates. */
export function wordsOf(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const ch of text.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      current += ch;
    } else if (current) {
      words.push(current);
      current = "";
    }
  }
  if (current) words.push(current);
  return words;
}

const stem = (word: string): string => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

function indexOfSequence(words: readonly string[], seq: readonly string[]): number {
  for (let i = 0; i + seq.length <= words.length; i++) {
    if (seq.every((w, j) => words[i + j] === w)) return i;
  }
  return -1;
}

function startsWith(words: readonly string[], seq: readonly string[]): boolean {
  return seq.length <= words.length && seq.every((w, i) => words[i] === w);
}

function wantsFullList(words: readonly string[]): boolean {
  for (const phrase of LIST_PHRASES) {
    const at = indexOfSequence(words, phrase);
    if (at >= 0 && words.slice(at + phrase.length).every((w) => LIST_TAIL.has(w))) return true;
  }
  const has = (set: ReadonlySet<string>): boolean => words.some((w) => set.has(w));
  return has(LIST_NOUNS) && has(LIST_CUES) && has(SELF_CUES) && !has(ACTIVITY);
}

/** Departments the message names; none means all of them. */
function departmentsNamed(words: readonly string[], departments: readonly SelfKnowledgeDepartment[]): SelfKnowledgeDepartment[] {
  const named = new Set(words.map((w) => DEPARTMENT_ALIASES[w] ?? w));
  return departments.filter((d) => named.has(d.id.toLowerCase()));
}

function renderList(departments: readonly SelfKnowledgeDepartment[], gated: ReadonlySet<string>, scoped: boolean): string {
  const toolCount = departments.reduce((n, d) => n + d.toolNames.length, 0);
  const lines = [
    `${scoped ? "These are" : "Every tool I have, by department, is below. These are"} read from my live tool list: ` +
      `${toolCount} tool${toolCount === 1 ? "" : "s"} across ${departments.length} department${departments.length === 1 ? "" : "s"}. ` +
      `"Asks first" means I wait for your approval in Telegram before the tool acts. A tool that is not listed is a tool I do not have.`,
  ];
  for (const d of departments) {
    const quote = (names: readonly string[]): string => names.map((n) => `\`${n}\``).join(", ");
    const asks = d.toolNames.filter((n) => gated.has(n));
    const free = d.toolNames.filter((n) => !gated.has(n));
    lines.push("", `**${d.id}** (${d.toolNames.length})`);
    if (free.length > 0) lines.push(`Runs on its own: ${quote(free)}`);
    if (asks.length > 0) lines.push(`Asks first: ${quote(asks)}`);
  }
  lines.push("", "Tell me what you want in plain words and I pick the tool.");
  return lines.join("\n");
}

/** Which departments carry each tool, in registry order. */
function departmentsByTool(departments: readonly SelfKnowledgeDepartment[]): Map<string, string[]> {
  const byTool = new Map<string, string[]>();
  for (const d of departments) {
    for (const name of d.toolNames) byTool.set(name, [...(byTool.get(name) ?? []), d.id]);
  }
  return byTool;
}

function answerCapability(words: readonly string[], departments: readonly SelfKnowledgeDepartment[], gated: ReadonlySet<string>): string | null {
  const opener = OPENERS.find((o) => startsWith(words, o));
  if (!opener) return null;
  const rest = words.slice(opener.length);
  const content = rest.filter((w) => !FILLER.has(w));
  if (content.length === 0 || content.length > CAPABILITY_MAX_CONTENT_WORDS) return null;

  const verbs = content.filter((w) => ACTION_VERBS.has(w));
  const nouns = content.filter((w) => !ACTION_VERBS.has(w));
  const explicit = rest.some((w) => EXPLICIT_TOOL_WORDS.has(w)) || opener.at(-1) === "support";

  const byTool = departmentsByTool(departments);
  const toolTokens = new Map<string, Set<string>>();
  for (const name of byTool.keys()) toolTokens.set(name, new Set(wordsOf(name).map(stem)));
  const vocabulary = new Set<string>();
  for (const tokens of toolTokens.values()) for (const t of tokens) if (!ACTION_VERBS.has(t)) vocabulary.add(t);

  const matched = nouns.filter((w) => vocabulary.has(stem(w)));
  const unmatched = nouns.filter((w) => !vocabulary.has(stem(w)));
  if (matched.length > 0 && unmatched.length > 0) return null; // a request with detail, not a capability question

  if (matched.length > 0) {
    const wanted = new Set(matched.map(stem));
    let tools = [...toolTokens].filter(([, tokens]) => [...wanted].some((w) => tokens.has(w))).map(([name]) => name);
    const narrowed = tools.filter((n) => verbs.some((v) => toolTokens.get(n)?.has(stem(v))));
    if (narrowed.length > 0) tools = narrowed;
    const shown = tools.slice(0, CAPABILITY_MAX_TOOLS_LISTED).map((n) => {
      const where = (byTool.get(n) ?? []).join(", ");
      return `- \`${n}\` (${where})${gated.has(n) ? " — asks first: I wait for your approval in Telegram" : ""}`;
    });
    const more = tools.length > shown.length ? [`- and ${tools.length - shown.length} more. Say "list your tools" for all of them.`] : [];
    return ["Yes. These tools in my live tool list cover it:", ...shown, ...more].join("\n");
  }

  // Nothing in the registry matches. A firm "no" only where the question is plainly about a tool or an outside action.
  const externalAsk = verbs.some((v) => EXTERNAL_VERBS.has(v));
  if (!explicit && !externalAsk) return null;
  const asked = nouns.length > 0 ? nouns : verbs;
  if (nouns.length === 0 && verbs.every((v) => [...toolTokens.values()].some((t) => t.has(stem(v))))) return null;
  return `No. I have no tool for ${asked.join(" ")}, so I cannot do that. Say "list your tools" to see everything I do have.`;
}

/**
 * The founder's message as a self-knowledge question, answered from the registry; null when it is
 * anything else (the planner takes it). Pure: the same message and registry give the same reply.
 */
export function answerSelfKnowledge(
  input: string,
  departments: readonly SelfKnowledgeDepartment[],
  gated: ReadonlySet<string>,
): string | null {
  const words = wordsOf(input);
  if (words.length === 0 || words.length > SELF_KNOWLEDGE_MAX_WORDS || departments.length === 0) return null;
  if (wantsFullList(words)) {
    const named = departmentsNamed(words, departments);
    return renderList(named.length > 0 ? named : departments, gated, named.length > 0);
  }
  return answerCapability(words, departments, gated);
}
