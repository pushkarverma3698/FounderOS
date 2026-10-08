/**
 * pnpm repo:add <owner/repo> [--dry-run] [--root <dir>]
 * =====================================================
 * Adds a repository to the Antigravity loop: one command instead of hand edits and a checklist.
 * A repo is registered in two places (the daemon reads the first through scripts/print-dispatch-repos.ts,
 * so it no longer has a list of its own; tests/unit/tools/dispatch-repo-serviceability.test.ts):
 *
 *   src/tools/dispatch-repos.ts              DISPATCH_REPO_ALLOWLIST  what /task accepts and the daemon sweeps
 *   tests/unit/tools/dispatch-repos.test.ts  PROVISIONED_REPOS        the reviewed pin
 *
 * Then it prints the one line only the founder can run, the VPS provisioning:
 *   ssh founderos-vps '~/bin/onboard-repo.sh owner/repo'
 *
 * Properties, each pinned in tests/unit/scripts/repo-add.test.ts:
 *  - STRICT INPUT. `owner/repo` and nothing else: the slug ends up inside a TS string, a bash
 *    double-quoted string and a single-quoted ssh command, so it is validated against GitHub's
 *    own charset rather than escaped.
 *  - ALL OR NOTHING ON PARSE. Every file is parsed and every edit computed in memory first. If
 *    any file has a shape this script cannot edit safely it throws and writes nothing.
 *  - IDEMPOTENT PER FILE. A repo already in a file (any case) is left alone, so a second run
 *    changes nothing and says so, and a run interrupted between files is finished by re-running.
 *  - ATOMIC WRITES, MODE KEPT. temp file + rename.
 *  - TAKES A ROOT. `--root` points it at a temp copy, so tests never touch the real files.
 *
 * Exit codes: 0 done (or nothing to do) · 1 a file could not be edited · 2 bad arguments.
 */

import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The two files `repo:add` edits, relative to the repo root, in the order they are written. */
export const REPO_ADD_TARGETS = {
  allowlist: "src/tools/dispatch-repos.ts",
  fixture: "tests/unit/tools/dispatch-repos.test.ts",
} as const;

/** GitHub's own limits: a user or org name is at most 39 characters, a repository name at most 100. */
const OWNER_MAX_CHARS = 39;
const REPO_MAX_CHARS = 100;
const OWNER_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_CHARS = /^[A-Za-z0-9._-]+$/;

const EXPECTED = "Expected a bare owner/repo such as acme/widget-server.";

/** An error the caller should print as-is. `exitCode` 2 is a usage problem, 1 is everything else. */
export class RepoAddError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
    this.name = "RepoAddError";
  }
}

export type SlugCheck = { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly reason: string };

const fail = (reason: string): SlugCheck => ({ ok: false, reason });

/** The bare `owner/repo` inside a pasted URL, host path or `.git` remote, for the "did you mean". */
function bareForm(raw: string): string {
  return raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^(?:www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

/**
 * Strict `owner/repo`. Deliberately does NOT normalise: this string is about to be written into
 * source files and a shell command, so anything but the bare form is refused with the bare form
 * suggested, never quietly rewritten.
 */
export function validateRepoSlug(raw: string): SlugCheck {
  if (raw === "") return fail(`No repository given. ${EXPECTED}`);
  if (raw !== raw.trim()) return fail(`${JSON.stringify(raw)} has leading or trailing whitespace. ${EXPECTED}`);

  // Anything that could mean something to a shell, a regex or a quote is named and refused here,
  // before any other rule, so the reason for `acme/x;rm -rf /` is the `;`, not a missing name.
  const never = [...new Set([...raw].filter((ch) => !/[A-Za-z0-9._:/@-]/.test(ch)))];
  if (never.length > 0) {
    return fail(`${JSON.stringify(raw)} contains characters that are never valid in an owner/repo: ${never.map((ch) => JSON.stringify(ch)).join(" ")}. ${EXPECTED}`);
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(?:www\.)?github\.com\//i.test(raw) || /\.git$/i.test(raw) || raw.endsWith("/")) {
    const bare = bareForm(raw);
    const suggestion = bare !== raw && validateRepoSlug(bare).ok ? ` Did you mean ${bare}?` : "";
    return fail(`${JSON.stringify(raw)} is a URL, a host path, or has a .git suffix or trailing slash.${suggestion} ${EXPECTED}`);
  }

  const parts = raw.split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) {
    return fail(`${JSON.stringify(raw)} is not owner/repo: it needs exactly one slash with a name on each side. ${EXPECTED}`);
  }
  if (owner.length > OWNER_MAX_CHARS) {
    return fail(`The owner ${JSON.stringify(owner)} is ${owner.length} characters; GitHub allows at most ${OWNER_MAX_CHARS}. ${EXPECTED}`);
  }
  if (!OWNER_SHAPE.test(owner)) {
    return fail(
      `The owner ${JSON.stringify(owner)} may only contain letters, digits and hyphens, and must not start or end with a hyphen. ${EXPECTED}`,
    );
  }
  if (name.length > REPO_MAX_CHARS) {
    return fail(`The repository name is ${name.length} characters; GitHub allows at most ${REPO_MAX_CHARS}. ${EXPECTED}`);
  }
  if (name === "." || name === "..") return fail(`The repository name ${JSON.stringify(name)} is not a name. ${EXPECTED}`);
  if (!REPO_CHARS.test(name)) {
    return fail(
      `The repository name ${JSON.stringify(name)} has characters GitHub does not accept; use letters, digits, '.', '_' and '-'. ${EXPECTED}`,
    );
  }
  return { ok: true, slug: raw };
}

/** The exact line the founder pastes to provision the VPS side. `slug` has been validated, so it is safe in single quotes. */
export function onboardCommand(slug: string): string {
  return `ssh founderos-vps '~/bin/onboard-repo.sh ${slug}'`;
}

// ── Editing ───────────────────────────────────────────────────────────────────

interface ListEdit {
  /** The entry as written in the file when the repo was already there, else null. */
  readonly present: string | null;
  /** The whole file after the edit. Identical to the input when `present`. */
  readonly text: string;
}

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Adds `slug` to a multi-line `<opener> … ] as const;` array whose every line is `  "owner/repo",`.
 * A comment or blank line is left alone; any other line means the shape changed and is refused.
 */
function editArrayBlock(source: string, opener: string, file: string, slug: string): ListEdit {
  const open = source.indexOf(opener);
  const where = `${file}: the \`${opener.replace(/^(?:export )?const /, "").replace(/ = \[$/, "")}\` list`;
  if (open < 0) throw new RepoAddError(`${where} was not found (looked for \`${opener}\`). Update scripts/repo-add.ts to the new shape.`);
  if (source.indexOf(opener, open + 1) >= 0) throw new RepoAddError(`${where} is declared more than once, so it is ambiguous which to edit.`);

  const bodyStart = open + opener.length;
  const close = source.indexOf("] as const;", bodyStart);
  if (close < 0) throw new RepoAddError(`${where} does not end with \`] as const;\`. Update scripts/repo-add.ts to the new shape.`);
  // The closing bracket must start its own line, so the new entry can be inserted above it.
  const lineStart = source.lastIndexOf("\n", close - 1) + 1;
  if (lineStart < bodyStart || source.slice(lineStart, close).trim() !== "") {
    throw new RepoAddError(`${where} shares its closing bracket's line with an entry. It must be one "owner/repo", per line.`);
  }

  const entries: string[] = [];
  let indent = "  ";
  for (const line of source.slice(bodyStart, lineStart).split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("//")) continue;
    const entry = /^"([^"\\]+)",$/.exec(text)?.[1];
    if (!entry) {
      throw new RepoAddError(`${where} has a line this script will not edit around: ${JSON.stringify(text)}. It must be one "owner/repo", per line.`);
    }
    entries.push(entry);
    indent = line.slice(0, line.length - line.trimStart().length);
  }

  const present = entries.find((entry) => sameRepo(entry, slug)) ?? null;
  if (present) return { present, text: source };
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return { present: null, text: `${source.slice(0, lineStart)}${indent}${JSON.stringify(slug)},${eol}${source.slice(lineStart)}` };
}

export interface FileEdit {
  readonly file: string;
  /** The list inside the file that is edited, for the report. */
  readonly label: string;
  readonly status: "added" | "present";
  readonly after: string;
}

export interface RepoAddPlan {
  readonly slug: string;
  /** The entry as already written in the repo when it was there (any case), else `slug`. */
  readonly canonical: string;
  readonly edits: readonly FileEdit[];
  readonly changed: boolean;
}

/**
 * Reads the two files and works out every edit in memory. Throws, having written nothing, if the
 * slug is invalid, a file is missing, or any list has a shape this script cannot edit safely.
 */
export function planRepoAdd(root: string, rawSlug: string): RepoAddPlan {
  const checked = validateRepoSlug(rawSlug);
  if (!checked.ok) throw new RepoAddError(checked.reason, 2);
  const slug = checked.slug;

  const missing = Object.values(REPO_ADD_TARGETS).filter((rel) => !existsSync(join(root, rel)));
  if (missing.length > 0) {
    throw new RepoAddError(`Cannot find ${missing.join(", ")} under ${root}. Run this from a FounderOS checkout, or pass --root <checkout>.`);
  }
  const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

  const allowlist = editArrayBlock(read(REPO_ADD_TARGETS.allowlist), "export const DISPATCH_REPO_ALLOWLIST = [", REPO_ADD_TARGETS.allowlist, slug);
  const fixture = editArrayBlock(read(REPO_ADD_TARGETS.fixture), "const PROVISIONED_REPOS = [", REPO_ADD_TARGETS.fixture, slug);

  const edits: FileEdit[] = [
    { file: REPO_ADD_TARGETS.allowlist, label: "DISPATCH_REPO_ALLOWLIST", status: allowlist.present ? "present" : "added", after: allowlist.text },
    { file: REPO_ADD_TARGETS.fixture, label: "PROVISIONED_REPOS", status: fixture.present ? "present" : "added", after: fixture.text },
  ];
  return {
    slug,
    canonical: allowlist.present ?? fixture.present ?? slug,
    edits,
    changed: edits.some((edit) => edit.status === "added"),
  };
}

/** Temp file in the same directory, mode copied from the original, then rename: never a half-written file. */
function writeAtomic(path: string, text: string): void {
  const mode = statSync(path).mode & 0o777;
  const temp = `${path}.repo-add-${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Writes the files that need it. A failure names what was and was not written; re-running finishes the job. */
export function applyRepoAdd(root: string, plan: RepoAddPlan): void {
  const written: string[] = [];
  for (const edit of plan.edits) {
    if (edit.status !== "added") continue;
    try {
      writeAtomic(join(root, edit.file), edit.after);
      written.push(edit.file);
    } catch (err) {
      const done = written.length > 0 ? `Already written: ${written.join(", ")}. ` : "Nothing was written. ";
      throw new RepoAddError(`Could not write ${edit.file}: ${(err as Error).message}. ${done}Re-run the same command to finish; it is idempotent.`);
    }
  }
}

/** The lines the founder reads: what changed per file, then the one thing only he can run. */
export function describePlan(plan: RepoAddPlan, opts: { readonly dryRun: boolean }): string[] {
  const verb = opts.dryRun ? "would change" : "changed";
  const lines = [`repo:add ${plan.canonical}`, ""];
  for (const edit of plan.edits) lines.push(`  ${edit.status === "added" ? verb : "present"}  ${edit.file}  (${edit.label})`);
  lines.push("");

  if (opts.dryRun) return [...lines, "Dry run: nothing was written."];
  if (!plan.changed) {
    return [
      ...lines,
      `Nothing changed: ${plan.canonical} is already registered in both files.`,
      "If the VPS side is not provisioned yet (safe to re-run):",
      `  ${onboardCommand(plan.canonical)}`,
    ];
  }
  return [
    ...lines,
    "Next, in order:",
    "  1. Review the diff, commit these files, open the PR and merge it.",
    "  2. When the deploy has landed, provision the VPS side (safe to re-run):",
    `       ${onboardCommand(plan.canonical)}`,
  ];
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const USAGE = [
  "Usage: pnpm repo:add <owner/repo> [--dry-run] [--root <dir>]",
  "  Adds the repo to DISPATCH_REPO_ALLOWLIST and the test pin, then prints the VPS command.",
  "  --dry-run   show what would change and write nothing",
  "  --root      edit another checkout instead of this one (the tests use a temp copy)",
];

export interface RepoAddResult {
  readonly code: 0 | 1 | 2;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Runs the command. Returns the lines to print instead of printing them, so the tests can read them. */
export function runRepoAdd(argv: readonly string[], defaultRoot: string = DEFAULT_ROOT): RepoAddResult {
  let root = defaultRoot;
  let dryRun = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") return { code: 0, out: USAGE, err: [] };
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--root") {
      const value = argv[++i];
      if (!value) return { code: 2, out: [], err: ["repo:add: --root needs a directory.", ...USAGE] };
      root = resolve(value);
    } else if (arg.startsWith("--root=")) root = resolve(arg.slice("--root=".length));
    else if (arg.startsWith("-")) return { code: 2, out: [], err: [`repo:add: unknown option ${JSON.stringify(arg)}.`, ...USAGE] };
    else positional.push(arg);
  }
  if (positional.length !== 1) {
    const problem = positional.length === 0 ? "No repository given." : `Expected one repository, got ${positional.length}.`;
    return { code: 2, out: [], err: [`repo:add: ${problem}`, ...USAGE] };
  }

  try {
    const plan = planRepoAdd(root, positional[0] as string);
    if (!dryRun) applyRepoAdd(root, plan);
    return { code: 0, out: describePlan(plan, { dryRun }), err: [] };
  } catch (err) {
    if (err instanceof RepoAddError) return { code: err.exitCode, out: [], err: [`repo:add: ${err.message}`] };
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = runRepoAdd(process.argv.slice(2));
  for (const line of result.out) console.log(line);
  for (const line of result.err) console.error(line);
  process.exitCode = result.code;
}
