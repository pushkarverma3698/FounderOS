/**
 * FounderOS — the Merge buttons under the evening list
 * ====================================================
 * `md:` callbacks (see merge-digest.ts). Two taps merge a pull request: Merge, then Yes. Both taps re-read GitHub, so
 * the click acts on what is true now, not on what was true when the list went out at 19:00.
 *
 * Merging is the founder's alone: telegram.ts lists the `md:` prefix among the decision buttons, so a guest in an
 * allow-listed group is refused before this handler runs.
 *
 * The merge is a squash pinned to the head the founder saw (`sha`), the same way pr-brain merges. If a commit landed
 * since, GitHub refuses it and so does the verdict above it. The audit row is written only after GitHub says merged.
 */

import type { Context } from "grammy";
import { Octokit } from "octokit";
import { TENANT } from "../core/config.js";
import { writeAuditEntry } from "../db/queries.js";
import { childLogger } from "../infra/logger.js";
import {
  MERGE_CALLBACK_PREFIX,
  mergeVerdict,
  parseMergeCallback,
  renderMergeConfirm,
  resolveMergeRepo,
  type MergeFacts,
} from "./merge-digest.js";
import { isGreenCI, isPrBrainReviewed } from "./tasks-ready.js";

export { MERGE_CALLBACK_PREFIX };

const log = childLogger({ module: "gateway:merge-digest-callback" });

export const MERGE_AUDIT_ACTION = "merge_digest_merge";

/** What GitHub says about one PR right now, plus its title and base for the prompt. */
export interface MergeInspection extends Omit<MergeFacts, "expectedSha7"> {
  readonly title: string;
  readonly base: string;
}

export interface MergeAuditRow {
  readonly slug: string;
  readonly pr: number;
  readonly sha: string;
  readonly base: string;
}

export interface MergeDeps {
  inspect(slug: string, pr: number): Promise<MergeInspection>;
  /** Squash-merges pinned to `sha`. Throws when GitHub refuses. */
  merge(slug: string, pr: number, sha: string): Promise<void>;
  /** True when a row was written. */
  audit(row: MergeAuditRow): Promise<boolean>;
}

function client(): { octokit: Octokit; token: string } {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return { octokit: new Octokit({ auth: token }), token };
}

function split(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) throw new Error(`not a valid owner/repo slug: ${slug}`);
  return { owner, repo };
}

export const liveMergeDeps: MergeDeps = {
  async inspect(slug, pr) {
    const { octokit } = client();
    const { owner, repo } = split(slug);
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr });
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pr,
      per_page: 100,
    });
    return {
      title: data.title,
      base: data.base.ref,
      state: data.state === "open" ? "open" : "closed",
      merged: data.merged,
      draft: data.draft ?? false,
      headSha: data.head.sha,
      reviewedForHead: isPrBrainReviewed(comments.map((c) => c.body ?? ""), data.head.sha),
      greenCI: await isGreenCI(octokit, owner, repo, data.head.sha),
      mergeable: data.mergeable,
      mergeableState: data.mergeable_state ?? null,
    };
  },
  async merge(slug, pr, sha) {
    const { octokit } = client();
    const { owner, repo } = split(slug);
    await octokit.rest.pulls.merge({ owner, repo, pull_number: pr, merge_method: "squash", sha });
  },
  async audit(row) {
    const { written } = await writeAuditEntry({
      tenant_id: TENANT,
      action: MERGE_AUDIT_ACTION,
      // One row per PR head: a retry of the same merge cannot write a second.
      idempotency_key: `${MERGE_AUDIT_ACTION}:${row.slug.toLowerCase()}:${row.pr}:${row.sha}`,
      payload: { repo: row.slug, pr: row.pr, sha: row.sha, base: row.base, via: "evening-digest-button" },
    });
    return written;
  },
};

/**
 * PRs whose confirm is being processed. Checked and set before any await, so two deliveries of the same tap (or a
 * fast double-tap) cannot both reach the merge: the second sees the first's mark on its very next line.
 */
const inFlight = new Set<string>();
export function _resetMergeInFlightForTests(): void {
  inFlight.clear();
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const clearButtons = (ctx: Context): Promise<unknown> =>
  // allow-failopen: clearing a spent keyboard is cosmetic; the decision it records is already made.
  ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);

/** False when the payload is not ours, so the next callback handler gets it. */
export async function handleMergeCallback(ctx: Context, deps: MergeDeps = liveMergeDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(MERGE_CALLBACK_PREFIX)) return false;

  const cb = parseMergeCallback(data);
  if (!cb) {
    await ctx.answerCallbackQuery({ text: "That button is out of date. Send /tasks for the current list." });
    return true;
  }
  const slug = resolveMergeRepo(cb.repoName);
  if (!slug) {
    await ctx.answerCallbackQuery({ text: `${cb.repoName} is not a repository I can merge for.`, show_alert: true });
    return true;
  }
  const label = `${slug.split("/")[1]} #${cb.pr}`;

  if (cb.action === "no") {
    await ctx.answerCallbackQuery({ text: "Cancelled. Nothing merged." });
    await clearButtons(ctx);
    return true;
  }

  const key = `${slug.toLowerCase()}#${cb.pr}`;
  if (cb.action === "yes") {
    if (inFlight.has(key)) {
      await ctx.answerCallbackQuery({ text: "Already merging this one." });
      return true;
    }
    inFlight.add(key);
  }

  try {
    let found: MergeInspection;
    try {
      found = await deps.inspect(slug, cb.pr);
    } catch (err) {
      await ctx.answerCallbackQuery({ text: "Could not read it." });
      await ctx.reply(`⚠️ Could not read ${label} on GitHub (${errText(err)}). Nothing was merged. Tap again in a minute.`);
      return true;
    }

    const verdict = mergeVerdict({ ...found, expectedSha7: cb.sha7 });
    if (!verdict.ok) {
      await ctx.answerCallbackQuery({ text: "Not merging." });
      await ctx.reply(`${verdict.already ? "ℹ️" : "⛔"} ${label}: ${verdict.reason}`);
      if (cb.action === "yes" || verdict.already) await clearButtons(ctx);
      return true;
    }

    if (cb.action === "ask") {
      const confirm = renderMergeConfirm({ repo: slug, pr: cb.pr, title: found.title, base: found.base, sha7: cb.sha7 });
      await ctx.answerCallbackQuery();
      await ctx.reply(confirm.text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [confirm.buttons.map((b) => ({ text: b.label, callback_data: b.data }))] },
      });
      return true;
    }

    // Confirmed. Spend the buttons first: a second tap must not look like a second merge.
    await ctx.answerCallbackQuery({ text: "Merging…" });
    await clearButtons(ctx);
    try {
      await deps.merge(slug, cb.pr, found.headSha);
    } catch (err) {
      log.warn({ slug, pr: cb.pr, err: errText(err) }, "Merge button: GitHub refused");
      await ctx.reply(`⛔ GitHub refused to merge ${label}: ${errText(err)}\nNothing was merged.`);
      return true;
    }

    let audited = true;
    try {
      audited = await deps.audit({ slug, pr: cb.pr, sha: found.headSha, base: found.base });
    } catch (err) {
      audited = false;
      log.error({ slug, pr: cb.pr, err: errText(err) }, "Merge button: merged, but the audit row failed");
    }
    log.info({ slug, pr: cb.pr, sha: found.headSha, base: found.base }, "Merge button: merged");
    const deploy = found.base === "main" ? " It deploys on merge." : "";
    await ctx.reply(
      `✅ Merged ${label} into ${found.base}.${deploy}${audited ? "" : "\n⚠️ The audit row could not be written; the merge itself is done."}`,
    );
    return true;
  } finally {
    if (cb.action === "yes") inFlight.delete(key);
  }
}
