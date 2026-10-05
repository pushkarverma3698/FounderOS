/**
 * FounderOS — /task dedupe
 * ========================
 * A request that is already in the loop is answered with its issue number, not filed a second time.
 *
 * WHY. On 10-03 issues #29 and #41 were each dispatched twice, and #38 was answered "Dispatched" three
 * times (UX audit F16). Each repeat is a real Antigravity run. The tool-side idempotency key is a hash
 * of the model's own title and scope, which the model words differently every turn, so it cannot catch
 * a re-sent request. This runs before the model, on the founder's own words.
 *
 * What counts as "the same request", in order:
 *   1. he names an issue (#77, or its URL) that is itself queued, working or in review;
 *   2. he names an issue that a queued task's title or body points at (#38 → filed as #77);
 *   3. his words appear, normalised, in a queued task's body (the brief files them verbatim as the
 *      Evidence), and are long enough to mean something.
 *
 * Only ready / working / review count. blocked and failed are waiting on a human, not in the queue.
 * The matcher is pure; the one GitHub read is `fetchQueuedIssues`.
 */

import { Octokit } from "octokit";
import { stateFromLabels } from "./tasks-command.js";

/** A request shorter than this (after normalising) is too generic to call a duplicate by text. */
const MIN_TEXT_MATCH_CHARS = 20;

export interface QueuedIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "ready" | "working" | "review";
}

const IN_FLIGHT: ReadonlySet<string> = new Set(["ready", "working", "review"]);

/** Issue numbers the text points at: `#29` or `…/issues/29`. Unique, in order of appearance. */
export function referencedIssueNumbers(text: string): number[] {
  const found = [...text.matchAll(/(?:#|\/issues\/)(\d{1,7})\b/g)].map((m) => Number(m[1]));
  return [...new Set(found)];
}

function mentions(haystack: string, issueNumber: number): boolean {
  return new RegExp(`#${issueNumber}(?!\\d)`).test(haystack);
}

/** Lowercase, punctuation and quoting (`> `) collapsed to single spaces. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The queued issue this request repeats, or null. */
export function findQueuedDuplicate(text: string, queued: readonly QueuedIssue[]): QueuedIssue | null {
  const inFlight = queued.filter((q) => IN_FLIGHT.has(q.state));
  if (inFlight.length === 0) return null;

  for (const n of referencedIssueNumbers(text)) {
    const hit =
      inFlight.find((q) => q.number === n) ?? inFlight.find((q) => mentions(`${q.title}\n${q.body}`, n));
    if (hit) return hit;
  }

  const wanted = normalise(text);
  if (wanted.length < MIN_TEXT_MATCH_CHARS) return null;
  return inFlight.find((q) => normalise(`${q.title} ${q.body}`).includes(wanted)) ?? null;
}

const STATE_PHRASE: Record<QueuedIssue["state"], string> = {
  ready: "waiting for its turn",
  working: "being built right now",
  review: "in review, its PR is open",
};

export function alreadyQueuedMessage(issue: QueuedIssue): string {
  return (
    `That's already queued as #${issue.number} (${STATE_PHRASE[issue.state]}). I did not file it again.\n` +
    "/tasks shows where it is. If it is a different job, reword it and send it again."
  );
}

/**
 * Open agent issues on one repo, in flight only. Throws when there is no token or GitHub fails: the
 * caller decides what a failed check means (here: dispatch anyway, since the card still gates it).
 */
export async function fetchQueuedIssues(slug: string): Promise<QueuedIssue[]> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) throw new Error(`not a valid owner/repo slug: ${slug}`);

  const { data } = await new Octokit({ auth: token }).rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  const queued: QueuedIssue[] = [];
  for (const issue of data) {
    if (issue.pull_request) continue;
    const state = stateFromLabels(issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))));
    if (state === "ready" || state === "working" || state === "review") {
      queued.push({ number: issue.number, title: issue.title, body: issue.body ?? "", state });
    }
  }
  return queued;
}

/** Production lookup: the queue of `repo`, matched against the founder's words. */
export async function lookupQueuedDuplicate(repo: string, text: string): Promise<QueuedIssue | null> {
  return findQueuedDuplicate(text, await fetchQueuedIssues(repo));
}

/**
 * The refusal text for a request that is already queued, or null to go ahead.
 *
 * A failed lookup goes ahead: the approval card still stands in front of any issue being filed, and a
 * GitHub blip must not take /task down.
 */
export async function queuedReply(
  find: ((repo: string, text: string) => Promise<QueuedIssue | null>) | undefined,
  repo: string,
  text: string,
): Promise<string | null> {
  try {
    const duplicate = await find?.(repo, text);
    return duplicate ? alreadyQueuedMessage(duplicate) : null;
  } catch {
    // allow-failopen: an unreadable queue must not block a dispatch that still stops at the approval card.
    return null;
  }
}
