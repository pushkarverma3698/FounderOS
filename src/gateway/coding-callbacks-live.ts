/**
 * FounderOS — the real GitHub, filesystem and audit behind the coding-pipeline buttons.
 * Kept apart from coding-callbacks.ts so the handler's tests never touch Octokit or Postgres.
 */

import fsp from "node:fs/promises";
import { Octokit } from "octokit";
import { TENANT } from "../core/config.js";
import { hasBeenAudited, writeAuditEntry } from "../db/queries.js";
import { contractsDir, type StoreFs } from "../tools/contract-store.js";
import type { CodingDeps } from "./coding-callbacks.js";

export const realFs: StoreFs = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, d) => fsp.writeFile(p, d),
  rename: (a, b) => fsp.rename(a, b),
  mkdir: async (p, o) => {
    await fsp.mkdir(p, o);
  },
  rm: (p) => fsp.rm(p, { recursive: true, force: true }),
};

function client(): Octokit {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return new Octokit({ auth: token });
}

function split(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) throw new Error(`not a valid owner/repo slug: ${slug}`);
  return { owner, repo };
}

export function liveCodingDeps(env: Record<string, string | undefined> = process.env): CodingDeps {
  return {
    env,
    fs: realFs,
    dir: contractsDir(env),
    now: () => new Date(),
    async setLabels(slug, issue, change) {
      const octokit = client();
      const { owner, repo } = split(slug);
      for (const name of change.remove) {
        try {
          await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issue, name });
        } catch (err) {
          // 404 means the label is already off the issue, which is the state we wanted.
          if ((err as { status?: number }).status !== 404) throw err;
        }
      }
      if (change.add.length > 0) await octokit.rest.issues.addLabels({ owner, repo, issue_number: issue, labels: [...change.add] });
    },
    async comment(slug, issue, body) {
      const { owner, repo } = split(slug);
      await client().rest.issues.createComment({ owner, repo, issue_number: issue, body });
    },
    async inspectPr(slug, pr) {
      const octokit = client();
      const { owner, repo } = split(slug);
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr });
      // The PR's own base.sha is where it branched; the tip of the base branch is what a merge lands on.
      const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${data.base.ref}` });
      return {
        state: data.state === "open" ? "open" : "closed",
        merged: data.merged,
        headSha: data.head.sha,
        baseSha: ref.data.object.sha,
        baseRef: data.base.ref,
      };
    },
    async merge(slug, pr, sha) {
      const { owner, repo } = split(slug);
      const res = await client().rest.pulls.merge({ owner, repo, pull_number: pr, merge_method: "squash", sha });
      return res.data.sha;
    },
    async updateBranch(slug, pr, expectedHead) {
      const { owner, repo } = split(slug);
      await client().rest.pulls.updateBranch({ owner, repo, pull_number: pr, expected_head_sha: expectedHead });
    },
    alreadyDone: (key) => hasBeenAudited(key),
    async audit(row) {
      const { written } = await writeAuditEntry({
        tenant_id: TENANT,
        action: row.action,
        idempotency_key: row.key,
        payload: row.payload,
      });
      return written;
    },
  };
}
