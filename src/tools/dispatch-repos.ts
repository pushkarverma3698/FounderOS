/**
 * FounderOS — Antigravity dispatch repo allowlist
 * ===============================================
 * The single place that decides which repositories the autonomous loop may open
 * `agent:ready` issues on, and therefore which repositories an unattended executor
 * may write to.
 *
 * WHY THIS IS A HARDCODED LIST AND NOT CONFIG. `repo` on `dispatch_antigravity_task`
 * is a model-supplied argument that takes precedence over every environment variable,
 * and the VPS `GITHUB_TOKEN` carries `repo`, `admin:org` and `delete_repo`. Between a
 * malformed instruction and any repository that token can write to, this list is the
 * only thing standing. Adding a repo should cost a code change, a PR and a review —
 * that audit trail is the feature, not an inconvenience. Same shape and same reasoning
 * as `VPS_RUN_PROFILE.imageAllowlist` in ./vps-run.ts.
 *
 * A repo added here is NOT automatically dispatchable: the VPS also needs a checkout
 * under /opt/review (pr-brain auto-discovers it) and one under /opt/agy-workspace owned
 * by the `antigravity` user, plus the six agent:* labels. See the plan in
 * docs/plans/ for the provisioning checklist.
 */

export const DISPATCH_REPO_ALLOWLIST = [
  "pushkarverma3698/FounderOS",
  "pushkarverma3698/House-of-Hulda-Website-frontend",
] as const;

export type DispatchRepo = (typeof DISPATCH_REPO_ALLOWLIST)[number];

export const DEFAULT_DISPATCH_REPO: DispatchRepo = DISPATCH_REPO_ALLOWLIST[0];

/**
 * Reduces the shapes a slug arrives in to bare `owner/repo`.
 *
 * The model pastes GitHub URLs, `gh` prints `.git` suffixes, and humans add trailing
 * slashes. None of those are a different repository, so none of them should be a
 * refusal — a refusal that fires on punctuation teaches the caller to work around the
 * allowlist rather than respect it.
 */
export function normalizeRepoSlug(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

/** The allowlist entry matching `slug` case-insensitively, or null. */
function canonicalize(slug: string): DispatchRepo | null {
  const lowered = slug.toLowerCase();
  return DISPATCH_REPO_ALLOWLIST.find((entry) => entry.toLowerCase() === lowered) ?? null;
}

/**
 * Resolves a slug to its canonical `{ owner, repo }`, or throws.
 *
 * Two distinct failures, deliberately kept as two distinct messages: a slug that is not
 * `owner/repo` is a typo, and a well-formed slug that is off the list is a policy
 * refusal. Collapsing them loses the only signal that tells the caller which one to fix.
 */
export function assertAllowedRepo(slug: string): { owner: string; repo: string } {
  const normalized = normalizeRepoSlug(slug);
  const parts = normalized.split("/");
  const [owner, repo] = parts;

  if (parts.length !== 2 || !owner || !repo) {
    throw new Error(`Invalid repository slug "${slug}". Expected "owner/repo".`);
  }

  const canonical = canonicalize(normalized);
  if (!canonical) {
    // The last line matters: this message reaches the model as a tool result, and
    // without it the model retries with a rephrased slug instead of stopping.
    throw new Error(
      `Repository "${normalized}" is not on the Antigravity dispatch allowlist.\n` +
        `Allowed: ${DISPATCH_REPO_ALLOWLIST.join(", ")}.\n` +
        "Adding one is a code change to DISPATCH_REPO_ALLOWLIST in src/tools/dispatch-repos.ts — " +
        "there is no runtime override.",
    );
  }

  const [canonicalOwner, canonicalRepo] = canonical.split("/") as [string, string];
  return { owner: canonicalOwner, repo: canonicalRepo };
}

/** True for a bare, well-formed `owner/repo`. */
function isWellFormedSlug(slug: string): boolean {
  const parts = slug.split("/");
  return parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]);
}

/**
 * Every repository dispatch may target: the hardcoded list, plus repositories this
 * instance created for the founder.
 *
 * Registered entries are re-validated here rather than trusted. They arrive from a
 * database read, and a boundary that trusts its own store is not a boundary — a single
 * corrupt row would otherwise be a way past it. Duplicates are collapsed, so a repo
 * recorded twice is one repo rather than an "ambiguous" refusal the founder can
 * neither see nor fix.
 */
function candidateRepos(registered: readonly string[]): readonly string[] {
  const extra = registered
    .map((entry) => normalizeRepoSlug(entry))
    .filter((entry) => isWellFormedSlug(entry) && !canonicalize(entry));

  return [...DISPATCH_REPO_ALLOWLIST, ...new Set(extra)];
}

/**
 * Resolves a slug against the hardcoded list PLUS the project repos this instance
 * created, or throws.
 *
 * WHY A SECOND ROUTE EXISTS AT ALL. A repository created last Tuesday cannot be in a
 * list compiled before it existed, and requiring a code change + deploy to work in a
 * brand-new project defeats the point of being able to start one from a phone. The
 * security property is preserved because naming a repository is still not how one gets
 * in here: the only way into `registered` is `create_project_repo`, which creates the
 * repo under the founder's own account behind an approval card. A model that names
 * someone else's repository is refused exactly as before — that repo was never created
 * by this system, so it is not in the store.
 */
export function assertDispatchableRepo(
  slug: string,
  registered: readonly string[],
): { owner: string; repo: string } {
  const normalized = normalizeRepoSlug(slug);

  if (!isWellFormedSlug(normalized)) {
    throw new Error(`Invalid repository slug "${slug}". Expected "owner/repo".`);
  }

  const allowed = candidateRepos(registered);
  const lowered = normalized.toLowerCase();
  const canonical = allowed.find((entry) => entry.toLowerCase() === lowered);

  if (!canonical) {
    // The last line matters: this message reaches the model as a tool result, and
    // without it the model retries with a rephrased slug instead of stopping.
    throw new Error(
      `Repository "${normalized}" is not on the Antigravity dispatch allowlist.\n` +
        `Allowed: ${allowed.join(", ")}.\n` +
        "Add one by creating it with create_project_repo, or by changing " +
        "DISPATCH_REPO_ALLOWLIST in src/tools/dispatch-repos.ts — naming it here does nothing.",
    );
  }

  const [owner, repo] = canonical.split("/") as [string, string];
  return { owner, repo };
}

/**
 * Every dispatchable repo a short hint could mean, for the `/task repo:<hint>` selector.
 *
 * Returns all matches rather than a best guess so the caller can refuse an ambiguous
 * hint out loud. Silently picking the first match would retarget a dispatch to a
 * repository the founder never named — the failure would land as a PR in the wrong
 * repo, which is exactly the class of silent misfire the allowlist exists to prevent.
 *
 * Matching is on the repo-name half only. Including the owner would make the account
 * name match every entry and read as permanently ambiguous.
 */
export function matchAllowlistedRepos(
  hint: string,
  registered: readonly string[] = [],
): readonly string[] {
  const normalized = normalizeRepoSlug(hint);
  if (!normalized) return [];

  const allowed = candidateRepos(registered);
  const lowered = normalized.toLowerCase();

  const exact = allowed.find((entry) => entry.toLowerCase() === lowered);
  if (exact) return [exact];

  return allowed.filter((entry) => {
    const name = entry.split("/")[1] ?? "";
    return name.toLowerCase().includes(lowered);
  });
}
