/**
 * Queue an issue that already exists: the one write path for "start work on #41" and "dispatch #762 again".
 * ========================================================================================================
 * Prod, 2026-10-07: "Start work on issue #41" made dispatch_antigravity_task file a NEW issue (#83) whose body was
 * that sentence, without reading #41, although PR #81 "(#41)" had been merged the day before. Both dispatch tools
 * now come here when the request names an existing issue: it is read first, a merged fix is reported with its
 * link, and otherwise THAT issue is relabelled after one card. Nothing new is ever filed.
 *
 * Everything above hitlGate is a read: the body runs again from the top when the founder approves (src/infra/hitl.ts).
 */

import { Octokit } from "octokit";
import { describeTaskStatus, fetchTaskFacts, type TaskFacts } from "../../tools/antigravity-status.js";
import { resolveDispatchRepo } from "../../tools/dispatch-antigravity.js";
import { startDispatchJob, startFailureNote } from "../../tools/dispatch-tick.js";
import { engineDisplay, engineLabel, parseEngine, readDefaultEngine, type Engine } from "../../tools/coding-engine.js";
import { founderWordsMarker } from "../../tools/founder-words.js";
import { readableIssueBody } from "../../tools/existing-issue.js";
import { NO_ACTION_PREFIX } from "../tool-result.js";
import { hitlGate, idemKey } from "./hitl.js";
import { blockedPrFix, claimAgeMinutes, fixBlockedPr, openPrWaitReason, WORKING_LEASE_MIN } from "./blocked-pr-fix.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tools:existing-issue-dispatch" });

export interface Target {
  readonly gh: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
}

export async function target(repoArg: string | null | undefined): Promise<Target | string> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) return "❌ Cannot read GitHub: GITHUB_TOKEN is not configured on the server.";
  try {
    const { owner, repo } = await resolveDispatchRepo(repoArg ?? undefined);
    return { gh: new Octokit({ auth: token }), owner, repo, slug: `${owner}/${repo}` };
  } catch (err) {
    return `❌ ${(err as Error).message}`;
  }
}

/**
 * Why this issue must not be queued now, or null. Each reason is what GitHub shows, never a guess: "already working"
 * was said about Oplify #115 on 2026-10-09 while nothing ran. A PR pr-brain blocked never gets here (it is fixed instead).
 */
export function refusal(facts: TaskFacts, now: Date = new Date()): string | null {
  const n = facts.issue.number;
  const labels = new Set(facts.issue.labels);
  if (facts.pr?.merged) {
    const stillOpen = facts.issue.state === "open" ? ` #${n} itself is still open; close it once you have checked the fix.` : "";
    return `#${n} is already fixed — PR #${facts.pr.number} merged into ${facts.pr.baseRef}: ${facts.pr.url}\nNothing was queued or filed.${stillOpen}`;
  }
  if (labels.has("agent:working")) {
    const age = claimAgeMinutes(facts, now);
    if (age === null) {
      return `Not re-queued: #${n} is labelled agent:working but no claim is recorded on it, so I cannot tell whether a run is live. Check ${facts.issue.url}.`;
    }
    if (age < WORKING_LEASE_MIN) {
      return `Not re-queued: Antigravity claimed it ${age} min ago and a run is cut off at 30 min. A second run would race it; ask again after that.`;
    }
  }
  const waiting = openPrWaitReason(facts);
  if (waiting) return `Not re-queued: ${waiting}`;
  if (labels.has("agent:review") && !facts.pr) {
    return `Not re-queued: #${n} is labelled agent:review but no PR is linked to it. Check ${facts.issue.url}.`;
  }
  if (labels.has("agent:blocked")) {
    return "Not re-queued: it stopped after 3 review→fix rounds on an open PR. It needs your decision on that PR — a fresh run would start over on top of it.";
  }
  return null;
}

/** No agent has had it: no agent:* label, or only the dispatcher's needs-brief parking. */
const neverRan = (labels: readonly string[]): boolean =>
  labels.every((l) => !l.startsWith("agent:") || l === "agent:needs-brief");

// agent:working and agent:review are only reached here when no run is live (see refusal) and no open PR waits on a decision.
const STALE_LABELS = ["agent:failed", "agent:blocked", "agent:needs-brief", "agent:working", "agent:review"] as const;

export interface QueueOptions {
  /** The founder's words, verbatim (src/tools/founder-words.ts). They go on the card and, as a marker, on the issue. */
  readonly founderWords: string;
  /** Settled by the caller; else a forced /claude or /agy, else the founder's default. Only a fresh issue gets one. */
  readonly engine?: Engine | undefined;
  readonly action: "dispatch_antigravity_task" | "requeue_antigravity_task";
  readonly repoArg: string | null | undefined;
}

type GateConfig = Parameters<typeof hitlGate>[1];

export async function queueExistingIssue(t: Target, n: number, opts: QueueOptions, config: GateConfig): Promise<string> {
  let facts: TaskFacts;
  try {
    facts = await fetchTaskFacts(t.gh, t.owner, t.repo, n);
  } catch (err) {
    return `❌ Could not read #${n} on ${t.slug}: ${(err as Error).message}. Nothing was filed.`;
  }
  if (facts.issue.isPull) return `❌ #${n} on ${t.slug} is a pull request, not an issue. Nothing was filed.`;
  const status = describeTaskStatus(facts, new Date());

  // A PR pr-brain blocked is waiting for exactly this decision: fix it now, on its own branch, with every blocker.
  const fix = blockedPrFix(facts);
  if (fix) {
    const req = { slug: t.slug, issueNumber: n, repoArg: opts.repoArg, founderWords: opts.founderWords, action: opts.action };
    return fixBlockedPr(fix, req, facts, status, config);
  }

  const refused = refusal(facts);
  if (refused) return `${NO_ACTION_PREFIX} ${refused}\n\n${status}`;

  // Already queued: starting its run changes nothing on GitHub, so no card.
  if (facts.issue.state === "open" && facts.issue.labels.includes("agent:ready")) {
    const started = await startDispatchJob(n, t.slug, "build");
    const note = started.status === "failed" ? `\n⚠️ ${startFailureNote(n, t.slug, started.reason)}` : "";
    return `${NO_ACTION_PREFIX} #${n} is already queued — I started its run now. Nothing new was filed.${note}\n\n${status}`;
  }

  const fresh = neverRan(facts.issue.labels);
  const executor = fresh
    ? opts.engine ?? parseEngine(config?.configurable?.["engine"] as string | undefined) ?? readDefaultEngine()
    : undefined;
  const labels = executor ? ["agent:ready", "antigravity", engineLabel(executor)] : ["agent:ready", "antigravity"];
  const body = facts.issue.body ?? "";
  const words = opts.founderWords.trim();

  // State-derived key: once this runs, the labels and comment count change, so a
  // replayed resume takes the "already queued" branch above instead of re-writing.
  const key = idemKey("requeue_antigravity", t.slug, String(n), String(facts.comments.length));
  if (await hasBeenAudited(key)) return `${NO_ACTION_PREFIX} #${n} was already queued from an earlier approval.\n\n${status}`;

  const who = executor ? engineDisplay(executor) : "Antigravity";
  const reopened = facts.issue.state === "closed" ? " (the closed issue is re-opened)" : "";
  const said = words ? `Your words: “${words}”\n\n` : "";
  const card = {
    title: fresh ? `🤖 Start work on #${n} with ${who}?` : `🔁 Put #${n} back in Antigravity's queue?`,
    summary: `Same issue, nothing new filed: ${t.slug}#${n} "${facts.issue.title}" → ${who}, labels ${labels.join(", ")}${reopened}`,
    preview: fresh ? `${said}${facts.issue.url}\n\n${readableIssueBody(body, 1200)}` : `${said}${status}`,
    args: { issue: n, repo: opts.repoArg ?? null, founder_words: words, engine: executor ?? null },
  };
  // One literal action per tool: tests/unit/agents/capabilities.test.ts proves every gated tool has a real gate.
  const rejected = opts.action === "requeue_antigravity_task"
    ? await hitlGate({ action: "requeue_antigravity_task", ...card }, config)
    : await hitlGate({ action: "dispatch_antigravity_task", ...card }, config);
  if (rejected) return rejected;

  const ref = { owner: t.owner, repo: t.repo, issue_number: n };
  if (facts.issue.state === "closed") await t.gh.rest.issues.update({ ...ref, state: "open" });
  for (const name of STALE_LABELS) {
    if (facts.issue.labels.includes(name)) await t.gh.rest.issues.removeLabel({ ...ref, name });
  }
  await t.gh.rest.issues.addLabels({ ...ref, labels });
  await t.gh.rest.issues.createComment({
    ...ref,
    body: words
      ? `🔁 Queued from Telegram by the founder: “${words}”. agent-dispatch picks up this same issue now.\n\n${founderWordsMarker(words)}`
      : "🔁 Re-queued from Telegram by the founder. agent-dispatch picks up this same issue now.",
  });
  const started = await startDispatchJob(n, t.slug, "build");
  const warn = started.status === "failed" ? `\n⚠️ ${startFailureNote(n, t.slug, started.reason)}` : "";

  const auditRes = await writeAuditEntry({
    action: opts.action,
    idempotency_key: key,
    payload: { issue_number: n, repo: t.slug, url: facts.issue.url, labels },
    tenant_id: TENANT,
  });
  if (!auditRes.written) log.warn({ key }, `writeAuditEntry conflict on ${opts.action}`);

  const when = facts.quotaUntil && facts.quotaUntil > new Date()
    ? `Antigravity's quota is exhausted until ${facts.quotaUntil.toISOString().slice(0, 16).replace("T", " ")} UTC, so it starts then.`
    : "Its run started now and reports back here.";
  if (fresh) return `✅ #${n} is queued for ${who} (same issue, nothing new filed). ${when}${warn}\n${facts.issue.url}`;
  return `✅ #${n} is back in Antigravity's queue (same issue, nothing new filed). ${when}${warn}\n${facts.issue.url}`;
}
