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

/**
 * Every allowlisted repo a short hint could mean, for the `/task repo:<hint>` selector.
 *
 * Returns all matches rather than a best guess so the caller can refuse an ambiguous
 * hint out loud. Silently picking the first match would retarget a dispatch to a
 * repository the founder never named — the failure would land as a PR in the wrong
 * repo, which is exactly the class of silent misfire the allowlist exists to prevent.
 *
 * Matching is on the repo-name half only. Including the owner would make the account
 * name match every entry and read as permanently ambiguous.
 */
export function matchAllowlistedRepos(hint: string): readonly DispatchRepo[] {
  const normalized = normalizeRepoSlug(hint);
  if (!normalized) return [];

  const exact = canonicalize(normalized);
  if (exact) return [exact];

  const needle = normalized.toLowerCase();
  return DISPATCH_REPO_ALLOWLIST.filter((entry) => {
    const name = entry.split("/")[1] ?? "";
    return name.toLowerCase().includes(needle);
  });
}
