/**
 * FounderOS — GitHub Tool (Octokit-backed)
 * ==========================================
 * Wraps the GitHub REST API via Octokit for common automation tasks:
 *  - list_repos    : list user repositories with key metadata
 *  - get_readme    : fetch README content of a repo (decoded from base64)
 *  - update_readme : update README, creating a commit (requires repo write access)
 *  - get_stats     : fetch authenticated user's public profile stats
 *  - create_issue  : open a new issue on a repository
 *  - create_repo   : create a new repository (public or private)
 *
 * Auth: requires GITHUB_TOKEN env var (classic PAT or fine-grained token).
 * Octokit is lazily instantiated — no cold-start overhead if GitHub is unused.
 *
 * See docs/decisions/007-why-octokit-for-github.md
 */

import { Octokit } from "octokit";
import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:github" });

// ── Octokit factory ───────────────────────────────────────────────────────────

function getOctokit(): Octokit {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN not configured — set it in .env");
  return new Octokit({ auth: token });
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function listRepos(octokit: Octokit, owner?: string): Promise<ToolResult> {
  if (owner) {
    const { data } = await octokit.rest.repos.listForUser({
      username: owner,
      per_page: 50,
      sort: "updated",
    });
    const repos = data.map((r) => ({
      name: r.name,
      full_name: r.full_name,
      description: r.description ?? null,
      language: r.language ?? null,
      stars: r.stargazers_count,
      forks: r.forks_count,
      private: r.private,
      url: r.html_url,
    }));
    return { success: true, data: { repos, count: repos.length } };
  }

  // No owner — list authenticated user's repos
  const { data } = await octokit.rest.repos.listForAuthenticatedUser({
    per_page: 50,
    sort: "updated",
    affiliation: "owner",
  });
  const repos = data.map((r) => ({
    name: r.name,
    full_name: r.full_name,
    description: r.description ?? null,
    language: r.language ?? null,
    stars: r.stargazers_count,
    forks: r.forks_count,
    private: r.private,
    url: r.html_url,
  }));
  return { success: true, data: { repos, count: repos.length } };
}

async function getReadme(octokit: Octokit, owner: string, repo: string): Promise<ToolResult> {
  const { data } = await octokit.rest.repos.getReadme({ owner, repo });
  // content arrives as base64 with newlines; strip before decoding
  const raw = (data as { content: string }).content.replace(/\n/g, "");
  const content = Buffer.from(raw, "base64").toString("utf-8");
  return { success: true, data: { content, sha: (data as { sha: string }).sha } };
}

async function updateReadme(
  octokit: Octokit,
  owner: string,
  repo: string,
  content: string,
): Promise<ToolResult> {
  // Must fetch current SHA before overwriting
  const { data: current } = await octokit.rest.repos.getReadme({ owner, repo });
  const sha = (current as { sha: string }).sha;

  const { data: updated } = await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: "README.md",
    message: "docs: update README via FounderOS github_agent",
    content: Buffer.from(content).toString("base64"),
    sha,
  });

  const commit = (updated as { commit: { sha: string; html_url: string } }).commit;
  log.info({ owner, repo, commit_sha: commit.sha }, "README updated");
  return { success: true, data: { commit_sha: commit.sha, commit_url: commit.html_url } };
}

async function getStats(octokit: Octokit): Promise<ToolResult> {
  const { data } = await octokit.rest.users.getAuthenticated();
  return {
    success: true,
    data: {
      login: data.login,
      name: data.name ?? null,
      bio: data.bio ?? null,
      followers: data.followers,
      following: data.following,
      public_repos: data.public_repos,
      public_gists: data.public_gists,
      profile_url: data.html_url,
      avatar_url: data.avatar_url,
    },
  };
}

async function createIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
  body?: string,
  labels?: string[],
): Promise<ToolResult> {
  const { data } = await octokit.rest.issues.create({
    owner,
    repo,
    title,
    body,
    labels,
  });
  log.info({ owner, repo, issue_number: data.number }, "GitHub issue created");
  return {
    success: true,
    data: {
      issue_number: data.number,
      issue_url: data.html_url,
      title: data.title,
    },
  };
}

async function createRepo(
  octokit: Octokit,
  name: string,
  description?: string,
  isPrivate?: boolean,
): Promise<ToolResult> {
  const { data } = await octokit.rest.repos.createForAuthenticatedUser({
    name,
    description,
    private: isPrivate ?? false,
    auto_init: true, // creates initial commit + README
  });
  log.info({ repo: data.full_name }, "GitHub repo created");
  return {
    success: true,
    data: {
      full_name: data.full_name,
      url: data.html_url,
      clone_url: data.clone_url,
      private: data.private,
    },
  };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const githubTool: UnifiedTool = {
  name: "github_mcp",
  description:
    "Interact with GitHub: list repos, read README, get profile stats, list issues/branches/commits, create issues and repos.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list_repos", "get_readme", "update_readme", "get_stats", "list_issues", "list_branches", "list_commits", "create_issue", "create_repo"],
        description: "The GitHub operation to perform. list_issues/list_branches/list_commits require owner+repo.",
      },
      owner: {
        type: "string",
        description: "GitHub username or org. Defaults to authenticated user for list_repos/get_stats.",
      },
      repo: {
        type: "string",
        description: "Repository name (without owner prefix). Required for get_readme, update_readme, create_issue.",
      },
      content: {
        type: "string",
        description: "For update_readme: full markdown content to write.",
      },
      title: {
        type: "string",
        description: "For create_issue: issue title. For create_repo: new repository name.",
      },
      body: {
        type: "string",
        description: "For create_issue: issue body markdown.",
      },
      private: {
        type: "string",
        description: "For create_repo: 'true' to create a private repo, omit or 'false' for public.",
      },
      labels: {
        type: "string",
        description: "For create_issue: comma-separated label names (e.g. 'bug,enhancement').",
      },
    },
    required: ["action"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args["action"] as string;

    let octokit: Octokit;
    try {
      octokit = getOctokit();
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    try {
      switch (action) {
        case "list_repos": {
          const owner = args["owner"] as string | undefined;
          return await listRepos(octokit, owner);
        }

        case "get_readme": {
          const owner = args["owner"] as string;
          const repo = args["repo"] as string;
          if (!owner || !repo) return { success: false, error: "get_readme requires owner and repo" };
          return await getReadme(octokit, owner, repo);
        }

        case "update_readme": {
          const owner = args["owner"] as string;
          const repo = args["repo"] as string;
          const content = args["content"] as string;
          if (!owner || !repo || !content)
            return { success: false, error: "update_readme requires owner, repo, and content" };
          return await updateReadme(octokit, owner, repo, content);
        }

        case "get_stats": {
          return await getStats(octokit);
        }

        case "list_issues": {
          const owner = args["owner"] as string;
          const repo = args["repo"] as string;
          if (!owner || !repo) return { success: false, error: "list_issues requires owner and repo" };
          const { data: issues } = await octokit.rest.issues.listForRepo({
            owner, repo, state: "open", per_page: 30, sort: "updated",
          });
          return {
            success: true,
            data: issues.map((i) => ({
              number: i.number,
              title: i.title,
              state: i.state,
              labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
              created_at: i.created_at,
              updated_at: i.updated_at,
              url: i.html_url,
            })),
          };
        }

        case "list_branches": {
          const owner = args["owner"] as string;
          const repo = args["repo"] as string;
          if (!owner || !repo) return { success: false, error: "list_branches requires owner and repo" };
          const { data: branches } = await octokit.rest.repos.listBranches({ owner, repo, per_page: 50 });
          return { success: true, data: branches.map((b) => ({ name: b.name, sha: b.commit.sha.slice(0, 8) })) };
        }

        case "list_commits": {
          const owner = args["owner"] as string;
          const repo = args["repo"] as string;
          const sha = (args["sha"] as string) ?? (args["ref"] as string) ?? "gemini/antigravityChanges";
          if (!owner || !repo) return { success: false, error: "list_commits requires owner and repo" };
          const { data: commits } = await octokit.rest.repos.listCommits({ owner, repo, sha, per_page: 20 });
          return {
            success: true,
            data: commits.map((c) => ({
              sha: c.sha.slice(0, 8),
              message: c.commit.message.split("\n")[0],
              author: c.commit.author?.name ?? "unknown",
              date: c.commit.author?.date,
            })),
          };
        }

        case "create_issue": {
          const owner = args["owner"] as string;
          const repo = args["repo"] as string;
          const title = args["title"] as string;
          if (!owner || !repo || !title)
            return { success: false, error: "create_issue requires owner, repo, and title" };
          const body = args["body"] as string | undefined;
          const labelsRaw = args["labels"] as string | undefined;
          const labels = labelsRaw ? labelsRaw.split(",").map((l) => l.trim()) : undefined;
          return await createIssue(octokit, owner, repo, title, body, labels);
        }

        case "create_repo": {
          const name = args["title"] as string;
          if (!name) return { success: false, error: "create_repo requires title (repository name)" };
          const description = args["body"] as string | undefined;
          const isPrivate = args["private"] === "true" || args["private"] === true;
          return await createRepo(octokit, name, description, isPrivate);
        }

        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      const message = (err as Error).message;
      log.error({ action, err: message }, "GitHub tool error");
      return { success: false, error: message };
    }
  },
};
