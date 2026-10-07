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
import { kickDispatchTick } from "../../tools/dispatch-tick.js";
import { engineDisplay, engineLabel, parseEngine, readDefaultEngine, type Engine } from "../../tools/coding-engine.js";
import { LABEL_SPEC, LABEL_SPEC_REVIEW } from "../../tools/pipeline-pending.js";
import { filedLabels } from "../../tools/dispatch-spec-intake.js";
import { existingIssueAsk, withFounderAsk } from "../../tools/existing-issue.js";
import { NO_ACTION_PREFIX } from "../tool-result.js";
import { hitlGate, idemKey } from "./hitl.js";
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

/** Why this issue must not be queued now, or null. */
export function refusal(facts: TaskFacts): string | null {
  const n = facts.issue.number;
  const labels = new Set(facts.issue.labels);
  if (facts.pr?.merged) {
    const stillOpen = facts.issue.state === "open" ? ` #${n} itself is still open; close it once you have checked the fix.` : "";
    return `#${n} is already fixed — PR #${facts.pr.number} merged into ${facts.pr.baseRef}: ${facts.pr.url}\nNothing was queued or filed.${stillOpen}`;
  }
  if (labels.has(LABEL_SPEC)) return `Not queued again: #${n}'s spec is being drafted.`;
  if (labels.has(LABEL_SPEC_REVIEW)) return `Not queued again: #${n}'s spec is waiting for your approval in Telegram.`;
  if (labels.has("agent:working") || labels.has("agent:review") || facts.pr?.state === "open") {
    return "Not re-queued: it is already in progress, and a second run would race the first.";
  }
  if (labels.has("agent:blocked")) {
    return "Not re-queued: it stopped after 3 review→fix rounds on an open PR. It needs your decision on that PR — a fresh run would start over on top of it.";
  }
  return null;
}

/** No agent has had it: no agent:* label, or only the dispatcher's needs-brief parking. */
const neverRan = (labels: readonly string[]): boolean =>
  labels.every((l) => !l.startsWith("agent:") || l === "agent:needs-brief");

const STALE_LABELS = ["agent:failed", "agent:blocked", "agent:needs-brief"] as const;

export interface QueueOptions {
  /** The founder's words, verbatim. Required when the issue goes to the spec pipeline (agent:spec). */
  readonly founderRequest?: string | null | undefined;
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

  const refused = refusal(facts);
  if (refused) return `${NO_ACTION_PREFIX} ${refused}\n\n${status}`;

  // Already queued: nudging the dispatcher changes nothing on GitHub, so no card.
  if (facts.issue.state === "open" && facts.issue.labels.includes("agent:ready")) {
    kickDispatchTick(n, t.slug);
    return `${NO_ACTION_PREFIX} #${n} is already queued — I nudged the dispatcher to pick it up now. Nothing new was filed.\n\n${status}`;
  }

  const fresh = neverRan(facts.issue.labels);
  const executor = fresh
    ? opts.engine ?? parseEngine(config?.configurable?.["engine"] as string | undefined) ?? readDefaultEngine()
    : undefined;
  const labels = executor ? filedLabels(["agent:ready", "antigravity", engineLabel(executor)]) : ["agent:ready", "antigravity"];
  const toSpec = labels.includes(LABEL_SPEC);
  const body = facts.issue.body ?? "";
  const request = opts.founderRequest?.trim() ? opts.founderRequest : "";
  if (toSpec && !request) {
    return `❌ Not queued: pass founder_request (the founder's words, verbatim). #${n} goes to the spec pipeline, which drafts the spec from them. Nothing was filed.`;
  }
  // Pass P drafts the spec from the ask alone and cannot read GitHub, so the ask carries what the issue says.
  const newBody = toSpec ? withFounderAsk(body, existingIssueAsk(request, { number: n, title: facts.issue.title, body })) : body;

  // State-derived key: once this runs, the labels and comment count change, so a
  // replayed resume takes the "already queued" branch above instead of re-writing.
  const key = idemKey("requeue_antigravity", t.slug, String(n), String(facts.comments.length));
  if (await hasBeenAudited(key)) return `${NO_ACTION_PREFIX} #${n} was already queued from an earlier approval.\n\n${status}`;

  const who = executor ? engineDisplay(executor) : "Antigravity";
  const notes = [
    newBody !== body ? "your words are appended to the issue for the spec" : "",
    facts.issue.state === "closed" ? "the closed issue is re-opened" : "",
  ].filter(Boolean);
  const card = {
    title: fresh ? `🤖 Start work on #${n} with ${who}?` : `🔁 Put #${n} back in Antigravity's queue?`,
    summary:
      `Same issue, nothing new filed: ${t.slug}#${n} "${facts.issue.title}" → ${labels.join(", ")}` +
      (notes.length ? ` (${notes.join("; ")})` : ""),
    preview: fresh ? `${facts.issue.url}\n\n${body.trim().slice(0, 1200)}` : status,
    args: { issue: n, repo: opts.repoArg ?? null, founder_request: opts.founderRequest ?? null, engine: executor ?? null },
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
  if (newBody !== body) await t.gh.rest.issues.update({ ...ref, body: newBody });
  await t.gh.rest.issues.addLabels({ ...ref, labels });
  await t.gh.rest.issues.createComment({
    ...ref,
    body: request
      ? `🔁 Queued from Telegram by the founder: “${request.trim()}”. agent-dispatch picks up this same issue on its next run.`
      : "🔁 Re-queued from Telegram by the founder. agent-dispatch picks up this same issue on its next run.",
  });
  kickDispatchTick(n, t.slug);

  const auditRes = await writeAuditEntry({
    action: opts.action,
    idempotency_key: key,
    payload: { issue_number: n, repo: t.slug, url: facts.issue.url, labels },
    tenant_id: TENANT,
  });
  if (!auditRes.written) log.warn({ key }, `writeAuditEntry conflict on ${opts.action}`);

  if (toSpec) {
    return (
      `✅ #${n} is queued for a spec on ${t.slug} (same issue, nothing new filed). The spec is drafted from your words and ` +
      `what #${n} says. A spec card will follow here in Telegram; nothing is built until you approve it. No agent is on it yet.\n${facts.issue.url}`
    );
  }
  const when = facts.quotaUntil && facts.quotaUntil > new Date()
    ? `Antigravity's quota is exhausted until ${facts.quotaUntil.toISOString().slice(0, 16).replace("T", " ")} UTC, so it starts then.`
    : "agent-dispatch picks it up within 15 minutes, usually at once.";
  if (fresh) return `✅ #${n} is queued for ${who} (same issue, nothing new filed). ${when} No agent is on it yet.\n${facts.issue.url}`;
  return `✅ #${n} is back in Antigravity's queue (same issue, nothing new filed). ${when}\n${facts.issue.url}`;
}
