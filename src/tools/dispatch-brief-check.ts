/**
 * FounderOS — where a brief's paths are looked up
 * ===============================================
 * The I/O half of the brief lint (./agent-brief-lint.ts is pure and asks through an injected
 * `fileExists`). This module supplies the real answers:
 *
 *   FounderOS  → the checkout the process runs from. Zero API calls, instant. Located with
 *                `repoRoot()` (src/evolution/repo-root.ts), which walks up from this module to
 *                the nearest package.json + src/, so it is right from src/ under tsx, from
 *                dist/src/ under `node dist/src/index.js`, and whatever the working directory.
 *                `process.cwd()` would only be right because systemd pins WorkingDirectory.
 *   any other  → GitHub's contents API on the repo's default branch.
 *
 * THE LOOP MUST NOT BLOCK ON ITS OWN INFRASTRUCTURE. Only a definite "no" rejects a path:
 *  - a GitHub 404 is definite, unless the repository itself is a 404 for this token (GitHub
 *    answers 404, not 403, for a private repo the token cannot read), in which case every path
 *    would look "missing" and no brief could ever get through. That is reported as "cannot say".
 *  - 5xx, 403, a network error and a timeout are all "cannot say": a warning line, not a rejection.
 *  - requests carry `retries: 0` and a timeout, because the octokit retry plugin would otherwise
 *    sleep 1s + 4s + 9s on every 5xx, per path.
 *
 * ONE SET OF LOOKUPS PER DISPATCH. hitlGate re-runs the tool from the top when the founder
 * approves, and execute() lints again as defence in depth. A passing verdict is therefore
 * remembered for the same repo and body, so a dispatch costs one set of GitHub lookups, not three.
 * A failing verdict is not remembered: the author fixes the brief, which changes the body, and a
 * path created since must be seen.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { childLogger } from "../infra/logger.js";
import { repoRoot } from "../evolution/repo-root.js";
import { DEFAULT_DISPATCH_REPO } from "./dispatch-repos.js";
import { lintAgentBrief, type BriefLintResult, type FileExists } from "./agent-brief-lint.js";

const log = childLogger({ module: "tool:dispatch-brief-check" });

/** Ceiling on one GitHub lookup, so a slow API cannot stall a dispatch. */
export const GITHUB_PATH_LOOKUP_TIMEOUT_MS = 5_000;

/** How long a passing verdict is reused: long enough to cover the founder's approval tap. */
export const BRIEF_CHECK_MEMO_TTL_MS = 30 * 60 * 1000;

/** Verdicts kept at once. The oldest is dropped first. */
export const BRIEF_CHECK_MEMO_MAX_ENTRIES = 32;

/** The slice of Octokit the lookups use, so tests can pass a fake and nothing else is reachable. */
export interface ContentsClient {
  readonly rest: {
    readonly repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        request?: { retries?: number; signal?: AbortSignal };
      }): Promise<unknown>;
      get(params: {
        owner: string;
        repo: string;
        request?: { retries?: number; signal?: AbortSignal };
      }): Promise<unknown>;
    };
  };
}

/** Answers from a directory on disk. Never answers for a path outside it. */
export function checkoutFileExists(root: string): FileExists {
  const base = resolve(root);
  return (path) => {
    const full = resolve(base, path);
    if (full !== base && !full.startsWith(base + sep)) return false;
    return existsSync(full);
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 404;
}

/** Answers from GitHub's default branch. A 404 is `false`; anything that is not an answer throws. */
export function githubFileExists(client: ContentsClient, owner: string, repo: string): FileExists {
  const request = () => ({ retries: 0, signal: AbortSignal.timeout(GITHUB_PATH_LOOKUP_TIMEOUT_MS) });

  // One reachability probe per lookup session, shared by every path that comes back 404.
  let repoVisible: Promise<boolean> | null = null;
  const isRepoVisible = (): Promise<boolean> => {
    repoVisible ??= client.rest.repos.get({ owner, repo, request: request() }).then(
      () => true,
      // allow-failopen: a failed probe (5xx, network) cannot prove the repo is hidden, so the path's own 404 stands.
      (err: unknown) => !isNotFound(err),
    );
    return repoVisible;
  };

  return async (path) => {
    try {
      await client.rest.repos.getContent({ owner, repo, path, request: request() });
      return true;
    } catch (err) {
      if (!isNotFound(err)) throw err;
      if (!(await isRepoVisible())) {
        throw new Error(`the token cannot see ${owner}/${repo} (GitHub answers 404 for the repository itself)`);
      }
      return false;
    }
  };
}

export interface BriefCheckDeps {
  /** Builds the GitHub client, only when a lookup needs it. May throw (no token). */
  readonly getClient: () => ContentsClient;
  /** The checkout to read FounderOS paths from, or null when there is none. Defaults to `repoRoot()`. */
  readonly checkoutRoot?: () => string | null;
  readonly now?: () => number;
}

function locateCheckout(): string | null {
  try {
    return repoRoot();
  } catch (err) {
    // allow-failopen: no checkout to read (a bundled build): FounderOS paths are asked of GitHub instead.
    log.warn({ err: (err as Error).message }, "repo root not found; checking FounderOS paths through GitHub");
    return null;
  }
}

/** The lookup for a target: the checkout for FounderOS, GitHub for the rest. */
function fileExistsFor(owner: string, repo: string, deps: BriefCheckDeps): { fileExists: FileExists; source: string } {
  if (`${owner}/${repo}`.toLowerCase() === DEFAULT_DISPATCH_REPO.toLowerCase()) {
    const root = (deps.checkoutRoot ?? locateCheckout)();
    if (root) return { fileExists: checkoutFileExists(root), source: "checkout" };
  }

  let inner: FileExists | null = null;
  return {
    source: "github",
    // The client is built on the first lookup, so a brief with no paths never needs a token.
    fileExists: (path) => {
      inner ??= githubFileExists(deps.getClient(), owner, repo);
      return inner(path);
    },
  };
}

const memo = new Map<string, { readonly at: number; readonly result: BriefLintResult }>();

/** Forgets every remembered verdict. For tests. */
export function resetBriefCheckMemo(): void {
  memo.clear();
}

function remember(key: string, result: BriefLintResult, at: number): void {
  memo.delete(key);
  memo.set(key, { at, result });
  while (memo.size > BRIEF_CHECK_MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/**
 * Lints a brief against the repo it would be filed on. Read-only, so it is safe above hitlGate.
 * A passing verdict is reused for the same repo and body (see the header).
 */
export async function checkDispatchBrief(
  target: { readonly owner: string; readonly repo: string; readonly body: string },
  deps: BriefCheckDeps,
): Promise<BriefLintResult> {
  const slug = `${target.owner}/${target.repo}`;
  const key = `${slug.toLowerCase()}\n${createHash("sha256").update(target.body).digest("hex")}`;
  const now = (deps.now ?? Date.now)();

  const hit = memo.get(key);
  if (hit && now - hit.at < BRIEF_CHECK_MEMO_TTL_MS) return hit.result;

  const { fileExists, source } = fileExistsFor(target.owner, target.repo, deps);
  const result = await lintAgentBrief(target.body, fileExists);
  if (result.ok) remember(key, result, now);

  const summary = {
    repo: slug,
    source,
    missingHeadings: result.missingHeadings,
    missingPaths: result.missingPaths,
    warnings: result.warnings.length,
  };
  if (result.ok) log.info(summary, "dispatch brief passed the lint");
  else log.warn(summary, "dispatch brief rejected by the lint; nothing will be filed");
  return result;
}
