/**
 * Evolution Engine — the ACTING loop: one finding becomes one GitHub issue.
 * ==========================================================================
 * Task 6 of docs/plans/2026-08-12-self-improvement-audit.md, as redirected by
 * the founder on 2026-08-13: "retarget the loop to use agent dispatch … the way
 * we create an issue."
 *
 * ## What this replaces, and why it had to be replaced
 *
 * The previous acting loop (`scripts/self-improve-cron.ts`) ran the Claude Code
 * CLI with `--permission-mode acceptEdits` against `process.cwd()`. It was never
 * scheduled, and could not have worked if it had been: `resolveExecutorCwd`
 * (src/tools/claude-code.ts) refuses the FounderOS repo on the laptop and
 * refuses `/opt/founderos` on prod for being outside `~/Projects`. Both were
 * verified by running it. So the "loop that acts" produced, on every host, an
 * error message.
 *
 * Issues are the better target regardless of that bug. The VPS already runs
 * `agent-dispatch` every 15 minutes (issue → isolated workspace → Antigravity →
 * draft PR) and `pr-brain` every 20 (adversarial review). Filing an issue puts
 * self-improvement on rails that already exist and already end in a human merge,
 * which is the gate Task 6 asked for and `acceptEdits` on a live tree is the
 * opposite of.
 *
 * ## The two failure modes this file is built against
 *
 * 1. FLOODING. One issue per run, at most, every three days. `agent-dispatch`
 *    claims one issue per tick and each claim spends a paid Antigravity
 *    invocation, so an unbounded filer would turn a tidiness backlog into a
 *    bill. Findings are also filtered by KIND before ranking is even consulted
 *    (see `DISPATCHABLE_KINDS`) — a cost hotspot is a decision for the founder,
 *    not a task for a robot.
 * 2. DUPLICATES. A finding that persists across audits must not spawn a fresh
 *    issue every three days. Every filed issue carries its finding's fingerprint
 *    in an HTML comment and the `evolution:auto` label; the next run reads its
 *    own history back before choosing a target.
 */

import { Octokit } from "octokit";
import { childLogger } from "../infra/logger.js";
import { runSelfAudit } from "./run-audit.js";
import { repoRoot } from "./repo-root.js";
import {
  AGENT_READY_LABEL,
  EVOLUTION_LABEL,
  FINDING_MARKER_PREFIX,
  isDispatchable,
  pickDispatchTarget,
  renderIssueBody,
  renderIssueTitle,
} from "./issue-body.js";
import type { Finding } from "./types.js";

const log = childLogger({ module: "evolution-dispatch" });

/** How many of this loop's own past issues to read back when checking for duplicates. */
export const FILED_HISTORY_PAGE_SIZE = 100;

/** Where issues are filed. Mirrors the `ISSUE_REPO` the VPS `agent-dispatch` cron reads. */
export function issueRepoSlug(): string {
  return process.env["SELF_IMPROVE_ISSUE_REPO"] ?? "pushkarverma3698/FounderOS";
}

/**
 * Kill switch, read at call time so a test can flip it per-run.
 *
 * Defaults to ON, unlike the other flags added in this remediation. Those gate
 * features whose absence is invisible; this one gates the only loop that turns
 * an audit into work, and a self-improvement loop that ships disabled is the
 * exact shipped-but-inert outcome the 2026-08-13 audit found for Tasks 2 and 4.
 * Set `SELF_IMPROVE_DISPATCH_ENABLED=false` to stop it filing anything.
 */
export function isDispatchEnabled(): boolean {
  return process.env["SELF_IMPROVE_DISPATCH_ENABLED"] !== "false";
}

/**
 * The narrow slice of GitHub this loop needs. An interface rather than a direct
 * Octokit call so the orchestration below is unit-testable with no token and no
 * network — the suite runs at $0 (CLAUDE.md).
 */
export interface IssueGateway {
  /** Bodies of every issue this loop has previously filed, newest first. */
  listAutoFiledBodies(): Promise<readonly string[]>;
  createIssue(input: {
    readonly title: string;
    readonly body: string;
    readonly labels: readonly string[];
  }): Promise<{ readonly number: number; readonly url: string }>;
}

export function octokitIssueGateway(slug: string = issueRepoSlug()): IssueGateway {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set — the self-improvement loop cannot file an issue. " +
        "Set it in .env (the same token the `gh` CLI uses on the VPS is sufficient: it needs `repo` scope).",
    );
  }
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) throw new Error(`SELF_IMPROVE_ISSUE_REPO must be "owner/repo", got "${slug}"`);

  const octokit = new Octokit({ auth: token });

  return {
    async listAutoFiledBodies() {
      // `state: "all"` on purpose: an issue that was closed WITHOUT the finding
      // being fixed must still suppress a re-file, or every close becomes an
      // invitation to re-open the same work three days later.
      const { data } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        labels: EVOLUTION_LABEL,
        state: "all",
        per_page: FILED_HISTORY_PAGE_SIZE,
        sort: "created",
        direction: "desc",
      });
      return data.map((issue) => issue.body ?? "");
    },
    async createIssue({ title, body, labels }) {
      const { data } = await octokit.rest.issues.create({
        owner,
        repo,
        title,
        body,
        labels: [...labels],
      });
      return { number: data.number, url: data.html_url };
    },
  };
}

/** Fingerprints already turned into issues, parsed from the markers in their bodies. */
export function parseFiledFingerprints(bodies: readonly string[]): Set<string> {
  const marker = new RegExp(`${FINDING_MARKER_PREFIX}\\s*([0-9a-f]{64})\\s*-->`, "gi");
  const found = new Set<string>();
  for (const body of bodies) {
    for (const match of body.matchAll(marker)) {
      const fingerprint = match[1];
      if (fingerprint) found.add(fingerprint.toLowerCase());
    }
  }
  return found;
}

export type DispatchOutcome =
  /** `SELF_IMPROVE_DISPATCH_ENABLED=false`. Nothing was audited and nothing is claimed. */
  | { readonly state: "disabled" }
  /** The audit ran; no finding was of a kind an unattended executor should be handed. */
  | { readonly state: "nothing-dispatchable"; readonly totalFindings: number }
  /** Every dispatchable finding already has an issue. The backlog is with the executor, not here. */
  | { readonly state: "all-filed"; readonly dispatchableCount: number }
  | {
      readonly state: "filed";
      readonly finding: Finding;
      readonly fingerprint: string;
      readonly issueNumber: number;
      readonly url: string;
    }
  /** The loop itself broke. Never silent — the founder sees this. */
  | { readonly state: "failed"; readonly reason: string };

/**
 * Run the analyzers and, if warranted, file exactly one issue.
 *
 * Deliberately does NOT persist findings. Loop A (`runSelfAuditSweep`, 08:00)
 * owns `evolution_findings`; if this loop persisted too, an hour later, every
 * finding's `times_seen` would advance twice per cycle and the recurrence
 * counter — the whole point of that table — would silently mean nothing.
 */
export async function runSelfImprovementDispatch(
  gateway: IssueGateway = octokitIssueGateway(),
  now: Date = new Date(),
): Promise<DispatchOutcome> {
  if (!isDispatchEnabled()) return { state: "disabled" };

  const run = await runSelfAudit(repoRoot());

  // The telemetry tier going dark is reported by Loop A's message, which fires an
  // hour earlier and names the analyzers that produced no result. Here it only
  // narrows what can be dispatched, so it is logged rather than repeated.
  if (run.telemetrySkippedReason !== null) {
    log.warn(
      { reason: run.telemetrySkippedReason },
      "Telemetry analyzers did not run — dispatch is choosing from static findings only",
    );
  }

  const dispatchable = run.ranked.filter(isDispatchable);
  if (dispatchable.length === 0) {
    return { state: "nothing-dispatchable", totalFindings: run.ranked.length };
  }

  const alreadyFiled = parseFiledFingerprints(await gateway.listAutoFiledBodies());
  const target = pickDispatchTarget(run.ranked, alreadyFiled);
  if (!target) {
    return { state: "all-filed", dispatchableCount: dispatchable.length };
  }

  const issue = await gateway.createIssue({
    title: renderIssueTitle(target.finding),
    body: renderIssueBody(target.finding, {
      fingerprint: target.fingerprint,
      commitSha: process.env["GIT_COMMIT_SHA"] ?? null,
      detectedAt: now,
    }),
    // Both labels, in this order, are the contract: `evolution:auto` is how the
    // NEXT run recognises this issue as its own, `agent:ready` is the intake gate
    // `agent-dispatch` claims on. ISSUE-DRIVEN-CONTRACT.md explicitly anticipates
    // "a future FounderOS tool" applying the gate once the template is satisfied,
    // which renderIssueBody guarantees section by section.
    labels: [EVOLUTION_LABEL, AGENT_READY_LABEL],
  });

  log.info(
    { issue: issue.number, kind: target.finding.kind, subject: target.finding.subject },
    "Self-improvement loop filed an issue for the agent dispatcher",
  );

  return {
    state: "filed",
    finding: target.finding,
    fingerprint: target.fingerprint,
    issueNumber: issue.number,
    url: issue.url,
  };
}
