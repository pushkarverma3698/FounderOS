/**
 * FounderOS — /promote: the pure parts
 * ====================================
 * What is on beta and not on main, the card the founder taps, and the request line that goes to the job socket.
 * No network, no clock, no process: the gateway (src/gateway/promote-command.ts) reads the compare result from the
 * hosting API and hands it here; deploy/promote-run does the promotion.
 *
 * Three repos can be promoted from Telegram, each beta -> its production branch. FounderOS goes to main and is
 * checked on its own box. The two Oplify repos go to `production` (their deploy workflows run off that branch);
 * there is no box of ours to check, so the job reports what the deploy workflow did, or that none ran.
 */

export type DeployCheck = "box" | "workflow";

export interface PromoteTarget {
  readonly repo: string;
  /** The branch beta is promoted into. */
  readonly base: string;
  readonly deploy: DeployCheck;
}

/** The only repos /promote may touch, by the short name the founder types. */
export const PROMOTE_TARGETS = {
  founderos: { repo: "pushkarverma3698/FounderOS", base: "main", deploy: "box" },
  "oplify-api": { repo: "OplifyMessage/oplify-messaging-api", base: "production", deploy: "workflow" },
  "oplify-app": { repo: "OplifyMessage/oplify-messaging-app", base: "production", deploy: "workflow" },
} as const satisfies Record<string, PromoteTarget>;

export type PromoteKey = keyof typeof PROMOTE_TARGETS;
export const PROMOTE_REPO = PROMOTE_TARGETS.founderos.repo;

const isPromoteKey = (k: string): k is PromoteKey => Object.prototype.hasOwnProperty.call(PROMOTE_TARGETS, k);

/** The target a typed name means ("" = FounderOS), or null for a name nobody wired. */
export function promoteTargetByKey(raw: string): { key: PromoteKey; target: PromoteTarget } | null {
  const key = raw.trim().toLowerCase() || "founderos";
  return isPromoteKey(key) ? { key, target: PROMOTE_TARGETS[key] } : null;
}

/** The target for a repo slug, or null when it is not promotable. */
export function promoteTargetByRepo(repo: string): PromoteTarget | null {
  const slug = repo.trim();
  return Object.values<PromoteTarget>(PROMOTE_TARGETS).find((t) => t.repo === slug) ?? null;
}

export interface PromotePr {
  readonly number: number;
  readonly title: string;
}

export interface PromotePlan {
  /** The branch beta goes into. */
  readonly base: string;
  /** The head of beta the card describes. The tap authorises exactly this commit. */
  readonly betaSha: string;
  /** Commits on beta that main lacks. */
  readonly aheadBy: number;
  /** Files that differ between main and beta. */
  readonly files: number;
  /** PRs found in those commits, oldest first, each once. */
  readonly prs: readonly PromotePr[];
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const MERGE_RE = /^Merge pull request #(\d+) from \S+/;
const TAGGED_RE = /^(.*\S)\s+\(#(\d+)\)\s*$/;
/** More PRs than this are summarised ("and 12 more"): a Telegram message is 4096 characters. */
const CARD_MAX_LISTED = 15;
const TITLE_MAX = 90;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The PR a commit message names, if any: a merge commit (title on its second paragraph) or a "title (#n)" commit. */
function prOfMessage(message: string): PromotePr | null {
  const lines = message.split("\n");
  const first = (lines[0] ?? "").trim();
  const merged = MERGE_RE.exec(first);
  if (merged) {
    const title = lines.slice(1).map((l) => l.trim()).find((l) => l !== "") ?? first;
    return { number: Number(merged[1]), title };
  }
  const tagged = TAGGED_RE.exec(first);
  if (tagged) return { number: Number(tagged[2]), title: (tagged[1] ?? "").trim() };
  return null;
}

/**
 * What promoting would carry, from the compare result for main...beta. Null means nothing to promote: beta is not
 * ahead, or it is ahead only by commits that change no file (a sync merge). Promoting those would put an empty merge
 * on main, and the sync job answers every main push with another sync PR, forever. A payload that is not a compare
 * result is also null: the caller says so, nobody guesses.
 */
export function planFromCompare(compare: unknown, betaSha: string, base = "main"): PromotePlan | null {
  if (!isRecord(compare)) return null;
  const commits = compare["commits"];
  const files = compare["files"];
  if (!Array.isArray(commits) || !Array.isArray(files)) return null;
  const aheadBy = typeof compare["ahead_by"] === "number" ? compare["ahead_by"] : commits.length;
  const status = compare["status"];
  if (status === "identical" || status === "behind" || aheadBy <= 0 || files.length === 0) return null;
  const seen = new Set<number>();
  const prs: PromotePr[] = [];
  for (const entry of commits) {
    const commit = isRecord(entry) ? entry["commit"] : undefined;
    const message = isRecord(commit) ? commit["message"] : undefined;
    const pr = typeof message === "string" ? prOfMessage(message) : null;
    if (pr && !seen.has(pr.number)) {
      seen.add(pr.number);
      prs.push(pr);
    }
  }
  return { base, betaSha, aheadBy, files: files.length, prs };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The approval card: what goes to prod, in the founder's words. Stays well under Telegram's 4096-character limit. */
export function promoteCardText(plan: PromotePlan, label = ""): string {
  const n = plan.prs.length;
  const where = label ? ` ${label}` : "";
  const lines = [n > 0 ? `Promote ${plural(n, "PR")}${where} to prod?` : `Promote${where} beta to prod?`, ""];
  for (const pr of plan.prs.slice(0, CARD_MAX_LISTED)) lines.push(`#${pr.number} ${clip(pr.title, TITLE_MAX)}`);
  if (n > CARD_MAX_LISTED) lines.push(`… and ${n - CARD_MAX_LISTED} more`);
  if (n === 0) lines.push(`${plural(plan.aheadBy, "commit")} with no PR number`);
  lines.push("");
  lines.push(
    `beta ${plan.betaSha.slice(0, 7)} into ${plan.base} (${plural(plan.files, "file")}). ` +
      `I open the promotion PR, wait for green CI, merge, then check the deploy.`,
  );
  return lines.join("\n");
}

/** Why a promotion request must not reach the socket, or null when it is fine. The job pins the repo and the commit. */
export function validatePromoteRequest(repo: string, betaSha: string): string | null {
  const slug = repo.trim();
  if (!REPO_RE.test(slug)) return `invalid repo "${slug}"`;
  if (!promoteTargetByRepo(slug)) {
    return `promotion is only wired for ${Object.values<PromoteTarget>(PROMOTE_TARGETS).map((t) => t.repo).join(", ")}, not ${slug}`;
  }
  if (!FULL_SHA_RE.test(betaSha)) return "beta sha must be 40 hex characters";
  return null;
}

/** The one JSON line deploy/job-run reads for stage=promote. Throws on a request the job would refuse anyway. */
export function promoteRequestLine(repo: string, betaSha: string): string {
  const problem = validatePromoteRequest(repo, betaSha);
  if (problem) throw new Error(problem);
  const target = promoteTargetByRepo(repo) as PromoteTarget;
  return `${JSON.stringify({ repo: target.repo, stage: "promote", beta_sha: betaSha, base: target.base, deploy: target.deploy })}\n`;
}
