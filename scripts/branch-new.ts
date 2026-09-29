/**
 * pnpm branch:new <type> <slug>
 * =============================
 * Cuts a work branch from FETCHED origin/main, named to the grammar in
 * docs/antigravity/BRANCHING-STRATEGY.md, in one command:
 *
 *   git fetch origin main
 *   git switch -c <prefix>/<type>-<slug> --no-track origin/main      (or <type>/<slug>)
 *   bash scripts/verify-branch-name.sh                               (pnpm verify:branch)
 *
 * WHY. Branches cut from a stale LOCAL `main` dragged a day of already-merged history into new
 * PRs. This never reads local `main`: it fetches first, branches from `origin/main`, and if the
 * fetch fails it stops rather than fall back to whatever `origin/main` last was.
 *
 * The prefix comes from $AGENT_PREFIX (`claude`, `cursor` or `antigravity`); unset gives a human's
 * `<type>/<slug>`. The grammar is scripts/verify-branch-name.sh's (a test runs both over the same
 * names): type from the list, slug of 2+ lowercase words, whole name at most 60 characters.
 * On top of that it refuses a harness codename (`sweet-pike-6b0c3c`), which the verifier lets
 * through by design because it allows a trailing harness hash.
 *
 * `--no-track`: `git switch -c x origin/main` would otherwise make origin/main the branch's
 * upstream, and a bare `git push` under `push.default=upstream` would then push to main.
 *
 * Checks that need no network (name, collision with a local branch) run before the fetch, so a
 * bad name costs nothing. A collision on origin is checked after it.
 *
 * Exit codes: 0 created · 1 could not create (git failed, name taken, verifier said no) · 2 bad arguments.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Kept identical to TYPES / AGENTS / MAX_LEN in scripts/verify-branch-name.sh; a test compares them. */
export const BRANCH_TYPES = ["feat", "fix", "hotfix", "chore", "docs", "refactor", "test"] as const;
export const AGENT_PREFIXES = ["claude", "cursor", "antigravity"] as const;
export const MAX_BRANCH_LENGTH = 60;

/** A network call that has not answered by now is not going to. */
const NETWORK_TIMEOUT_MS = 60_000;

const CODENAME_DOC = 'docs/antigravity/BRANCHING-STRATEGY.md, "The banned shape: harness codenames"';

const quote = (text: string): string => JSON.stringify(text);

/** Six lowercase letters and digits, mixed: what the harnesses append (`-6b0c3c`, `-d76aa2`, `-552ryl`). */
function looksLikeHarnessHash(word: string): boolean {
  return /^[a-z0-9]{6}$/.test(word) && /\d/.test(word) && /[a-z]/.test(word);
}

export type BranchVerdict =
  | { readonly ok: true; readonly branch: string }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Every problem with the request, each with its own reason. Pure. */
export function validateBranchRequest(request: {
  readonly type: string;
  readonly slug: string;
  readonly agentPrefix: string;
}): BranchVerdict {
  const { type, slug, agentPrefix } = request;
  const problems: string[] = [];

  const typeOk = (BRANCH_TYPES as readonly string[]).includes(type);
  if (!typeOk) problems.push(`type ${quote(type)} is not one of ${BRANCH_TYPES.join(", ")}.`);

  const prefixOk = agentPrefix === "" || (AGENT_PREFIXES as readonly string[]).includes(agentPrefix);
  if (!prefixOk) {
    problems.push(
      `AGENT_PREFIX=${quote(agentPrefix)} is not one of ${AGENT_PREFIXES.join(", ")}. Leave it unset for a branch of your own (<type>/<slug>).`,
    );
  }

  let slugOk = true;
  if (slug === "") {
    problems.push("the slug is empty. Name the subject of the work in 2 or more words, e.g. jobhunt-cv-claim-guard.");
    slugOk = false;
  } else {
    if (slug !== slug.toLowerCase()) {
      problems.push(`slug ${quote(slug)} has uppercase letters: use lowercase (${quote(slug.toLowerCase())}).`);
      slugOk = false;
    }
    const foreign = [...new Set([...slug.toLowerCase()].filter((ch) => !/[a-z0-9-]/.test(ch)))];
    if (foreign.length > 0) {
      problems.push(`slug may only contain lowercase letters, digits and hyphens; found ${foreign.map(quote).join(" ")}.`);
      slugOk = false;
    }
    const words = slug.split("-");
    if (words.some((word) => word === "")) {
      problems.push("slug must not start or end with a hyphen or contain a doubled hyphen: that leaves an empty word.");
      slugOk = false;
    } else if (words.length < 2) {
      problems.push(`slug ${quote(slug)} needs 2 or more words joined by single hyphens: a one-word slug names nothing about the work.`);
      slugOk = false;
    }
    const last = words[words.length - 1] ?? "";
    if (slugOk && looksLikeHarnessHash(last)) {
      problems.push(
        `the last word ${quote(last)} looks like a harness hash, so ${quote(slug)} is a harness codename: it names nothing about the work. ` +
          `Name the subject of the work instead (${CODENAME_DOC}). If ${quote(last)} is a real word, put another word after it.`,
      );
    }
  }

  if (typeOk && prefixOk) {
    const name = agentPrefix ? `${agentPrefix}/${type}-${slug}` : `${type}/${slug}`;
    if (name.length > MAX_BRANCH_LENGTH) {
      problems.push(
        `the branch name ${quote(name)} would be ${name.length} characters; the limit is ${MAX_BRANCH_LENGTH}. Shorten the slug by ${name.length - MAX_BRANCH_LENGTH}.`,
      );
    }
    if (problems.length === 0) return { ok: true, branch: name };
  }
  return { ok: false, problems };
}

const LEGAL_SHAPES = [
  "Legal shapes (docs/antigravity/BRANCHING-STRATEGY.md § Naming grammar):",
  `  <type>/<slug>            with AGENT_PREFIX unset;  type = ${BRANCH_TYPES.join("|")}`,
  `  <agent>/<type>-<slug>    with AGENT_PREFIX set;    agent = ${AGENT_PREFIXES.join("|")}`,
];

export interface BranchNewOptions {
  readonly type: string;
  readonly slug: string;
  readonly agentPrefix: string;
  /** The checkout to branch in. */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The branch-name verifier. Defaults to scripts/verify-branch-name.sh next to this file. */
  readonly verifyScript?: string;
}

export interface BranchNewResult {
  readonly code: 0 | 1 | 2;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly branch?: string;
}

const DEFAULT_VERIFY_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "verify-branch-name.sh");

/** Creates the branch. Returns the lines to print instead of printing them, so the tests can read them. */
export function runBranchNew(opts: BranchNewOptions): BranchNewResult {
  const verdict = validateBranchRequest(opts);
  if (!verdict.ok) {
    const n = verdict.problems.length;
    return {
      code: 2,
      out: [],
      err: [
        `branch:new: cannot create that branch. ${n} ${n === 1 ? "problem" : "problems"}:`,
        ...verdict.problems.map((problem, i) => `  ${i + 1}. ${problem}`),
        "",
        ...LEGAL_SHAPES,
      ],
    };
  }
  const branch = verdict.branch;

  // Never prompt for credentials: an agent has no one to answer, and a hang is worse than a failure.
  const env = { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: "0" };
  const git = (args: readonly string[], timeout?: number) =>
    spawnSync("git", [...args], { cwd: opts.cwd, env, encoding: "utf8", timeout });
  const failed = (...err: string[]): BranchNewResult => ({ code: 1, out: [], err: err.map((line) => `branch:new: ${line}`) });
  const said = (r: { stdout?: string | null; stderr?: string | null; error?: Error }): string =>
    [r.stderr, r.stdout, r.error?.message].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");

  if (git(["rev-parse", "--show-toplevel"]).status !== 0) {
    return failed(`not inside a git repository (${opts.cwd}). Run this from the FounderOS checkout.`);
  }
  if (git(["remote", "get-url", "origin"]).status !== 0) {
    return failed("this checkout has no 'origin' remote, so there is no origin/main to branch from. Add it: git remote add origin <url>");
  }

  if (git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0) {
    return failed(
      `Branch ${quote(branch)} already exists in this checkout. Pick a different slug, or continue that work with: git switch ${branch}. ` +
        "(BRANCHING-STRATEGY.md rule 3: never resurrect a stale branch for new, unrelated work.)",
    );
  }

  const fetched = git(["fetch", "origin", "main"], NETWORK_TIMEOUT_MS);
  if (fetched.status !== 0) {
    return failed(
      `git fetch origin main failed: ${said(fetched) || "no output"}`,
      "Refusing to branch from a possibly stale origin/main. Fix the connection or credentials, then re-run.",
    );
  }
  const base = git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"]);
  if (base.status !== 0) {
    return failed("origin/main does not exist after the fetch. Is the default branch on this remote called something other than main?");
  }
  const baseSha = base.stdout.trim();

  const notes: string[] = [];
  const onOrigin = git(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], NETWORK_TIMEOUT_MS);
  if (onOrigin.status === 0) {
    return failed(
      `Branch ${quote(branch)} already exists on origin. Pick a different slug: a same-named branch cut from today's main would be rejected at push, ` +
        "and the old one is somebody's unmerged work.",
    );
  }
  if (onOrigin.status !== 2) {
    // allow-failopen: the fetch just succeeded, so origin is reachable; a failed collision probe is reported, and git itself rejects a colliding push.
    notes.push(`Could not check whether ${branch} already exists on origin (git ls-remote: ${said(onOrigin) || `exit ${onOrigin.status}`}); continuing.`);
  }

  const carried = git(["status", "--porcelain"]).stdout.split("\n").filter((line) => line.trim() !== "").length;
  const switched = git(["switch", "-c", branch, "--no-track", "origin/main"]);
  if (switched.status !== 0) {
    return failed(`git switch -c ${branch} origin/main failed: ${said(switched) || "no output"}`);
  }

  const out = [`Created ${branch} from origin/main at ${baseSha.slice(0, 7)} (fetched just now).`, ...notes];
  if (carried > 0) {
    out.push(`${carried} uncommitted change${carried === 1 ? "" : "s"} came with you: ${carried === 1 ? "it is" : "they are"} now on ${branch}.`);
  }

  // The verifier reads the current branch; a stray GITHUB_HEAD_REF would make it check another name.
  const verifyEnv = { ...env };
  delete verifyEnv["GITHUB_HEAD_REF"];
  const verify = spawnSync("bash", [opts.verifyScript ?? DEFAULT_VERIFY_SCRIPT], { cwd: opts.cwd, env: verifyEnv, encoding: "utf8" });
  const verdictText = `${verify.stdout ?? ""}${verify.stderr ?? ""}`.trim();
  if (verify.status !== 0) {
    return {
      code: 1,
      out,
      err: [verdictText, "", `The branch ${branch} exists, but verify:branch rejected it. Rename it before pushing: git branch -m <better-name>`],
      branch,
    };
  }
  return { code: 0, out: [...out, verdictText], err: [], branch };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const USAGE = [
  "Usage: pnpm branch:new <type> <slug>",
  `  <type>  one of ${BRANCH_TYPES.join(", ")}`,
  "  <slug>  2+ lowercase words joined by hyphens that name the work, e.g. jobhunt-cv-claim-guard",
  `  Set AGENT_PREFIX to ${AGENT_PREFIXES.join(", ")} for an agent branch (<agent>/<type>-<slug>); leave it unset for <type>/<slug>.`,
];

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    for (const line of [
      `branch:new: expected <type> <slug>, got ${args.length} argument${args.length === 1 ? "" : "s"}.`,
      ...(args.length > 2 ? [`Join the words with hyphens: pnpm branch:new ${args[0]} ${args.slice(1).join("-")}`] : []),
      ...USAGE,
    ]) {
      console.error(line);
    }
    process.exitCode = 2;
  } else {
    const result = runBranchNew({
      type: args[0] as string,
      slug: args[1] as string,
      agentPrefix: process.env["AGENT_PREFIX"] ?? "",
      cwd: process.cwd(),
    });
    for (const line of result.out) console.log(line);
    for (const line of result.err) console.error(line);
    process.exitCode = result.code;
  }
}
