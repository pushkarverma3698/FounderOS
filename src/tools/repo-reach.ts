/**
 * FounderOS - can the bot's GITHUB_TOKEN reach this repo?
 * =======================================================
 * /task used to file an issue on any allowlisted repo and find out hours later, in the daemon's log,
 * that the VPS token could not see it (a 404 on a private repo, a read-only grant). The token the
 * daemons run with is the same GITHUB_TOKEN FounderOS runs with (AG-039), so asking GitHub with that
 * token, BEFORE anything is filed, tells the founder in chat what the daemons would hit later.
 *
 * decideRepoReach is pure: it takes what GitHub answered and returns a verdict, so it is tested with
 * object literals. checkRepoReach is the one repos.get call that feeds it. Both are read-only, which
 * the hitlGate contract requires of everything above the gate (src/infra/hitl.ts).
 *
 * Failure direction. Only an answer that PROVES the token cannot reach the repo refuses: 401, 403, 404,
 * or a permissions block with push, admin and maintain all false. A 5xx, a timeout, a network error or
 * an answer without a permissions block proves nothing, so the dispatch goes on: the brief lint and
 * issues.create still speak, and a GitHub outage must not stop every /task.
 */

export interface RepoPermissions {
  readonly admin?: boolean;
  readonly maintain?: boolean;
  readonly push?: boolean;
  readonly pull?: boolean;
}

export interface RepoAnswered {
  readonly kind: "answered";
  readonly permissions: RepoPermissions | null | undefined;
}

export interface RepoLookupFailed {
  readonly kind: "failed";
  readonly status: number | undefined;
  readonly message: string;
}

/** What one repos.get told us, reduced to what the decision reads. */
export type RepoReachObservation = RepoAnswered | RepoLookupFailed;

export type RepoReachVerdict = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** The statuses that mean "this token is not allowed to see or use this repo". */
const UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/** How long the probe may take before the dispatch goes on without it. */
export const REPO_REACH_TIMEOUT_MS = 8_000;

const SUFFIX = "the bot's GITHUB_TOKEN cannot reach this repo.";

export function decideRepoReach(slug: string, observed: RepoReachObservation): RepoReachVerdict {
  if (observed.kind === "failed") {
    if (observed.status === undefined || !UNREACHABLE_STATUSES.has(observed.status)) return { ok: true };
    return { ok: false, message: `${slug}: GitHub answered ${observed.status} "${observed.message}", so ${SUFFIX} Nothing was filed.` };
  }
  const p = observed.permissions;
  const canWrite = p?.push === true || p?.admin === true || p?.maintain === true;
  const deniedOutright = p?.push === false || p?.admin === false || p?.maintain === false;
  if (p && !canWrite && deniedOutright) {
    return { ok: false, message: `${slug}: GitHub answered 200, but the token has no push permission (push, admin and maintain are all false), so ${SUFFIX} Nothing was filed.` };
  }
  return { ok: true };
}

/** The slice of Octokit the probe uses. */
export interface RepoReachClient {
  readonly rest: {
    readonly repos: {
      get(params: { owner: string; repo: string; request?: { signal?: AbortSignal } }): Promise<unknown>;
    };
  };
}

function statusOf(err: unknown): number | undefined {
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
}

function permissionsOf(response: unknown): RepoPermissions | undefined {
  const data = typeof response === "object" && response !== null ? (response as { data?: unknown }).data : undefined;
  const permissions = typeof data === "object" && data !== null ? (data as { permissions?: unknown }).permissions : undefined;
  return typeof permissions === "object" && permissions !== null ? (permissions as RepoPermissions) : undefined;
}

/** Asks GitHub, with the client's token, about the repo, and decides. */
export async function checkRepoReach(target: { owner: string; repo: string }, client: RepoReachClient): Promise<RepoReachVerdict> {
  const slug = `${target.owner}/${target.repo}`;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`GitHub did not answer within ${REPO_REACH_TIMEOUT_MS} ms`));
    }, REPO_REACH_TIMEOUT_MS);
  });
  try {
    const ask = client.rest.repos.get({ owner: target.owner, repo: target.repo, request: { signal: controller.signal } });
    const response = await Promise.race([ask, expired]);
    return decideRepoReach(slug, { kind: "answered", permissions: permissionsOf(response) });
  } catch (err) {
    // allow-failopen: a probe that failed without a 401/403/404 (5xx, timeout, network) proves nothing about reach, so decideRepoReach lets the dispatch go on.
    return decideRepoReach(slug, { kind: "failed", status: statusOf(err), message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
}
