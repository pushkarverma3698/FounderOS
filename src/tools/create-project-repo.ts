/**
 * FounderOS — start a new project repository
 * ==========================================
 * Creates a repository under the founder's own GitHub account AND registers it as a
 * target the Claude↔Antigravity loop may write to, in one approved action.
 *
 * WHY THIS IS NOT JUST `github_write create_repo`. That already creates repos, and has
 * for months — but a repo created that way is not dispatchable, because
 * `DISPATCH_REPO_ALLOWLIST` is compiled into the binary and a repository created five
 * minutes ago cannot be in it. The founder would get a repo and then be told his own
 * new project is "not on the Antigravity dispatch allowlist", with the only remedy
 * being a code change and a deploy. That is the opposite of being able to start
 * something from a phone.
 *
 * WHY THIS DOES NOT REOPEN THE HOLE THE ALLOWLIST CLOSED. The threat was a
 * model-supplied `repo` argument naming an arbitrary repository the VPS token can
 * write to — and that token carries `repo`, `admin:org` and `delete_repo`. Naming is
 * still not how a repository gets in here. The only entry is creation, which:
 *   · goes through `createForAuthenticatedUser`, so the owner is always the founder;
 *   · is HITL-gated in the wrapper, so he sees and approves the name;
 *   · registers only AFTER GitHub confirms the repo exists, by its returned full_name.
 * A repository that already belongs to someone else can never be created by us, so it
 * can never be registered, so it is still refused.
 *
 * WHAT THIS DOES NOT DO. It does not provision the VPS. `agent-dispatch` fetches and
 * resets ONE pinned workspace and contains no `git clone` at all, so until a checkout
 * exists under /opt/agy-workspace (and one under /opt/review for the reviewer), an
 * issue filed against a new repo is an issue nothing will ever claim. The commands to
 * fix that are returned in `next_steps` rather than left for the founder to discover
 * by watching nothing happen.
 */

import { childLogger } from "../infra/logger.js";
import { githubTool } from "./github.js";
import { hasBeenAudited, registerDispatchRepo } from "../db/queries.js";
import { DISPATCH_REPO_ALLOWLIST } from "./dispatch-repos.js";
import { TENANT } from "../core/config.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:create-project-repo" });

/** GitHub's own cap on a repository name. */
const MAX_REPO_NAME_LENGTH = 100;

/** What GitHub accepts verbatim, without rewriting the name it was given. */
const LEGAL_REPO_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Why the name is checked instead of slugified: GitHub silently rewrites some names
 * (spaces become hyphens), so a slugifying create returns a repo whose real name
 * differs from the one we registered — and the registered slug is what authorises
 * dispatch. A mismatch there is a repo the founder can see but the loop cannot use.
 *
 * Returns null when the name is fine, or the reason it is not.
 */
export function validateProjectRepoName(raw: string): string | null {
  const name = raw.trim();

  if (!name) return "A repository name is required.";
  if (name.length > MAX_REPO_NAME_LENGTH) {
    return `Repository names are capped at ${MAX_REPO_NAME_LENGTH} characters; that one is ${name.length}.`;
  }
  if (name.includes("/")) {
    return `"${name}" contains a slash. Give the repository name only — the owner is always your own account.`;
  }
  if (/\s/.test(name)) {
    return `"${name}" contains a space. GitHub would rewrite it, so the created repo would not match the registered name. Use hyphens.`;
  }
  if (!LEGAL_REPO_NAME.test(name)) {
    return `"${name}" has characters GitHub does not accept. Use letters, digits, hyphens, underscores and dots.`;
  }

  const collision = DISPATCH_REPO_ALLOWLIST.find(
    (entry) => (entry.split("/")[1] ?? "").toLowerCase() === name.toLowerCase(),
  );
  if (collision) return `"${name}" already exists as ${collision}.`;

  return null;
}

/** What still has to happen on the VPS before the loop can actually run in a new repo. */
function provisioningSteps(slug: string): string {
  const name = slug.split("/")[1] ?? slug;
  return [
    `The repo exists and dispatch will accept it. The VPS still needs a checkout before`,
    `Antigravity or the reviewer can work in it:`,
    ``,
    `  ssh founderos-vps`,
    `  sudo -n git clone https://github.com/${slug}.git /opt/review/${name}`,
    `  sudo -n git clone https://github.com/${slug}.git /opt/agy-workspace/${name}`,
    `  sudo -n chown -R antigravity:antigravity /opt/agy-workspace/${name}`,
    `  for l in ready working review blocked failed; do gh label create "agent:$l" -R ${slug}; done`,
    `  gh label create antigravity -R ${slug}`,
    ``,
    `Then add ${slug} to AGENT_DISPATCH_REPOS in the crontab.`,
  ].join("\n");
}

export const createProjectRepoTool: UnifiedTool = {
  name: "create_project_repo",
  description:
    "Start a NEW project: creates a repository under the founder's GitHub account and registers it " +
    "as a repository the Antigravity agent loop may be dispatched to. Use this when the founder wants " +
    "to begin a new project that does not exist yet. Requires founder approval.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Repository name only, no owner and no slashes (e.g. 'turicks-pricing-api'). " +
          "Letters, digits, hyphens, underscores and dots.",
      },
      description: {
        type: "string",
        description: "One-line description of what the project is for.",
      },
      isPrivate: {
        type: "boolean",
        description: "Defaults to true. Pass false only when the founder explicitly asks for a public repo.",
      },
    },
    required: ["name"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args["name"] ?? "").trim();
    const description = args["description"] as string | undefined;
    // Private unless explicitly told otherwise: a repo can be opened up later, but a
    // private one that was published cannot be un-published.
    const isPrivate = args["isPrivate"] === false ? false : true;

    const invalid = validateProjectRepoName(name);
    if (invalid) return { success: false, error: invalid };

    // Idempotency BEFORE the API call: the HITL resume loop re-runs this tool from the
    // top, and a second create would either fail on the name or make a second repo.
    const key = `create_project_repo:${name.toLowerCase()}`;
    try {
      if (await hasBeenAudited(key)) {
        return {
          success: true,
          data: { name, skipped: true, note: `${name} was already created by this system.` },
        };
      }
    } catch (err) {
      // allow-failopen: an unreadable audit table must not block creating a project; GitHub rejects a duplicate name anyway.
      log.warn({ name, err: (err as Error).message }, "idempotency check failed — continuing");
    }

    let created: ToolResult;
    try {
      created = await githubTool.execute({
        action: "create_repo",
        title: name,
        ...(description ? { body: description } : {}),
        private: String(isPrivate),
      });
    } catch (err) {
      // TOOL-STANDARDS.md check 1 — execute() never throws.
      return { success: false, error: `Could not create ${name}: ${(err as Error).message}` };
    }

    if (!created.success) {
      return { success: false, error: `Could not create ${name}: ${created.error ?? "unknown error"}` };
    }

    // Soft-failure check (TOOL-STANDARDS.md #3): trust the slug GitHub returns, never
    // the one we asked for. Registering an unconfirmed name is the one mistake here
    // that would matter — it would mark a repository dispatchable that we do not own.
    const slug = (created.data as { full_name?: unknown } | undefined)?.full_name;
    if (typeof slug !== "string" || !slug.includes("/")) {
      return {
        success: false,
        error: `GitHub reported success but returned no repository name for "${name}" — not registering it for dispatch.`,
      };
    }

    const registered = await registerDispatchRepo(slug, TENANT);
    if (!registered.written) {
      log.warn({ slug }, "dispatch repo was already registered — idempotent no-op");
    }

    log.info({ slug, isPrivate }, "created and registered a new project repo");

    return {
      success: true,
      data: {
        repo: slug,
        url: (created.data as { url?: string } | undefined)?.url,
        private: isPrivate,
        dispatchable: true,
        next_steps: provisioningSteps(slug),
      },
    };
  },
};
