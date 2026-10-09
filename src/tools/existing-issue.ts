/**
 * Work that already has an issue: which issue a request names, and which PR already fixes it.
 * ===========================================================================================
 * Prod, 2026-10-07: "Start work on issue #41" made the bot file a NEW issue (#83) whose body was that sentence,
 * without reading #41, although PR #81 "(#41)" had been merged the day before. The dispatch path runs these
 * first, so a request naming an existing issue reads that issue and either reports its fix or queues it.
 *
 *   parseIssueReference  pure: the issue numbers a request names on the target repo (PR numbers excluded)
 *   findFixingPr         pure: the merged PR that fixes issue N, else an open PR that says it closes N
 *   fetchCrossRefPrs     the PRs on issue N's timeline (GitHub records every PR that mentions it)
 *   existingIssueAsk     the ask for that issue: the founder's words, then what the issue says
 *   withFounderAsk       the issue body with the ask appended as the spec-intake section
 *
 * A PR targeting `beta` never auto-closes its issue (GitHub closes issues only on the default branch), so an
 * open issue is no proof that nothing fixed it. That is why the timeline is read.
 */

import type { Octokit } from "octokit";
import { extractAsk } from "./pipeline-spec.js";
import { VERBATIM_HEADING, verbatimAskSection } from "./dispatch-spec-intake.js";

export type IssueReference =
  | { kind: "none" }
  | { kind: "one"; number: number }
  | { kind: "many"; numbers: number[] };

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// One pass, left to right, so a URL or owner/repo#N is consumed before its tail could match as a bare #N.
const REFERENCE =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)|([\w.-]+\/[\w.-]+)#(\d+)\b|\bissues?\s+(?:number\s+)?#?(\d+)\b|(?<![&#\w])#(\d+)\b/gi;

/** A bare #N right after these words is a PR, a rule or a step, not an issue ("review PR #81", "rule #26"). */
const NOT_AN_ISSUE_BEFORE = /\b(?:PRs?|pull(?:\s+requests?)?|MRs?|rules?|steps?)\s*$/i;

/**
 * The existing issues on `targetSlug` that the texts name, deduplicated, in the order named. Matches "issue #41",
 * "issue 41", "issue number 41", a bare "#41", ".../issues/41" and "owner/repo#41"; skips pull-request numbers and
 * anything that names another repo.
 */
export function parseIssueReference(targetSlug: string, ...texts: Array<string | null | undefined>): IssueReference {
  const numbers: number[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(REFERENCE)) {
      const [, urlRepo, urlKind, urlNum, slugRepo, slugNum, wordNum, bareNum] = m;
      let n: string | undefined;
      if (urlNum !== undefined) {
        if (urlKind?.toLowerCase() !== "issues" || !sameRepo(urlRepo ?? "", targetSlug)) continue;
        n = urlNum;
      } else if (slugNum !== undefined) {
        if (!sameRepo(slugRepo ?? "", targetSlug)) continue;
        n = slugNum;
      } else if (wordNum !== undefined) {
        n = wordNum;
      } else {
        if (NOT_AN_ISSUE_BEFORE.test(text.slice(0, m.index))) continue;
        n = bareNum;
      }
      const num = Number(n);
      if (Number.isSafeInteger(num) && num > 0 && !numbers.includes(num)) numbers.push(num);
    }
  }
  if (numbers.length === 0) return { kind: "none" };
  if (numbers.length === 1) return { kind: "one", number: numbers[0] as number };
  return { kind: "many", numbers };
}

/** A pull request that mentions an issue, as the issue's timeline records it. */
export interface CrossRefPr {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  mergedAt: string | null;
  url: string;
}

/**
 * The PR that fixes issue `n`: the latest MERGED one whose title names #n (the "(#41)" convention) or whose title or
 * body says "fixes/closes/resolves #n". Failing that, an OPEN PR that says it closes #n (work in flight). A PR that
 * only mentions #n in passing ("Open issues: #41, #46") fixes nothing.
 */
export function findFixingPr(n: number, repoSlug: string, prs: readonly CrossRefPr[]): CrossRefPr | null {
  const ref = `(?:${esc(repoSlug)})?#${n}(?!\\d)`;
  const named = new RegExp(`(?:^|[^\\w&/])${ref}`, "i");
  const closes = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+${ref}`, "i");
  const mine = prs.filter((p) => sameRepo(p.repo, repoSlug));
  const merged = mine
    .filter((p) => p.mergedAt !== null && (named.test(p.title) || closes.test(p.title) || closes.test(p.body)))
    .sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""));
  if (merged[0]) return merged[0];
  return mine.find((p) => p.state === "open" && (closes.test(p.title) || closes.test(p.body))) ?? null;
}

interface TimelineSource {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  repository?: { full_name?: string };
  pull_request?: { merged_at?: string | null } | null;
}

/** Every pull request on issue `n`'s timeline (one entry per PR). */
export async function fetchCrossRefPrs(octokit: Octokit, owner: string, repo: string, n: number): Promise<CrossRefPr[]> {
  const events = (await octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
    owner,
    repo,
    issue_number: n,
    per_page: 100,
  })) as unknown as Array<{ event?: string; source?: { issue?: TimelineSource } }>;
  const out: CrossRefPr[] = [];
  for (const e of events) {
    const src = e.source?.issue;
    if (e.event !== "cross-referenced" || !src?.pull_request || typeof src.number !== "number") continue;
    const pr: CrossRefPr = {
      repo: src.repository?.full_name ?? `${owner}/${repo}`,
      number: src.number,
      title: src.title ?? "",
      body: src.body ?? "",
      state: src.state ?? "",
      mergedAt: src.pull_request.merged_at ?? null,
      url: src.html_url ?? "",
    };
    if (!out.some((p) => p.number === pr.number && sameRepo(p.repo, pr.repo))) out.push(pr);
  }
  return out;
}

/**
 * The issue body with the founder's words appended as the `## Founder request (verbatim)` section Pass P binds the
 * spec to. An imported issue (#41 came from a bug tracker) has none, and without it Pass P parks the issue as
 * needs-brief. A body that already ends with an ask is returned unchanged.
 */
export function withFounderAsk(body: string, founderRequest: string): string {
  if (extractAsk(body).ok) return body;
  const head = body.trimEnd();
  return [...(head ? [head, ""] : []), ...verbatimAskSection(founderRequest)].join("\n").trimEnd();
}

/**
 * The ask Pass P drafts a spec from when the founder points at an existing issue. Pass P's prompt holds only the ask
 * (deploy/lib/pass-p.sh) and its sandbox cannot read GitHub, so "Start work on issue #41" alone would give it nothing
 * to specify. His words come first and unedited; the issue as filed follows, labelled as such.
 */
export function existingIssueAsk(founderRequest: string, issue: { number: number; title: string; body: string }): string {
  const filed = [`Issue #${issue.number} as filed on GitHub: ${issue.title}`, issue.body.trim()].filter(Boolean).join("\n\n");
  return [founderRequest.trimEnd(), "", "---", filed].join("\n");
}

/**
 * The issue body as the approval card shows it: text, not its encoding. An imported issue (Oplify's bug-tracker
 * migration) stores its body as a JSON string literal, so the card read `"**Area/Module:** ...\\n**Status:**"`;
 * a body already carrying the spec-intake section would also show the founder his own words back, fenced. The
 * literal is decoded, the section dropped, and the cut lands on a word with an ellipsis (it used to stop mid-word).
 */
export function readableIssueBody(body: string, max: number): string {
  const marker = body.indexOf(`## ${VERBATIM_HEADING}`);
  let text = (marker >= 0 ? body.slice(0, marker) : body).trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(text);
      if (typeof decoded === "string") text = decoded.trim();
    } catch {
      // allow-failopen: not a JSON string literal after all; the text is shown as written.
    }
  }
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.search(/\s\S*$/);
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
