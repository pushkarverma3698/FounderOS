/**
 * The merge card for one reviewed job PR (branch task/issue-N), for deploy/vps-daemons/pr-brain. Bash does the Telegram
 * send; every judgement (what the required CI says, what the review decided, may this head be merged, what does the card
 * print, what does a tap act on) is made here, by the pure functions in src/tools/ and src/gateway/coding-cards.ts.
 * The card is keyed on the job, not on a spec contract (AG-062), and pr-brain never merges these PRs itself.
 *
 *   node --import tsx/esm scripts/pipeline-evidence-card.ts --repo owner/name --issue N --pr P --head SHA --verdict TEXT
 *     -> {"status":"NONE","reason"}                           the review did not clear the PR: the blocked card covers it
 *      | {"status":"CARD","nonce","parts":[html..],"reply_markup","mergeable"}
 *      | {"status":"FAILED","error"}                             could not build the card: HOLD the merge
 *
 * --head is the PR head pr-brain reviewed; --verdict is pr-brain's own verdict line. Always exits 0 and prints one JSON
 * line. Read-only on GitHub (readOnlyGh). The only write is the "merge" pending record the [Merge] button points at,
 * and only when a merge button is on the card.
 */
import * as fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { renderEvidenceCard } from "../src/gateway/coding-cards.js";
import { requiredCiVerdict, reviewDecisionOf } from "../src/tools/pipeline-evidence-card.js";
import { contractsDir, newNonce, writePending, type StoreFs } from "../src/tools/pipeline-pending.js";
import { canMerge } from "../src/tools/pr-evidence.js";
import { execGh, readOnlyGh, type GhRunner } from "./gh-read.js";

export interface EvidenceCardDeps {
  fs: StoreFs;
  gh: GhRunner;
  nonce: () => string;
  now: () => Date;
}

const line = (v: unknown): string => JSON.stringify(v) + "\n";
const failed = (error: string): string => line({ status: "FAILED", error });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Args {
  repo: string;
  issue: number;
  pr: number;
  head: string;
  verdict: string;
}
const USAGE = "usage: pipeline-evidence-card.ts --repo owner/name --issue N --pr P --head SHA --verdict TEXT";

function parseArgs(argv: string[]): { ok: true; value: Args } | { ok: false; error: string } {
  const got = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i] as string;
    const v = argv[i + 1];
    if (!["--repo", "--issue", "--pr", "--head", "--verdict"].includes(k) || v === undefined || got.has(k)) return { ok: false, error: `bad argument ${k}. ${USAGE}` };
    got.set(k, v);
  }
  const repo = got.get("--repo") ?? "";
  const issue = Number(got.get("--issue"));
  const pr = Number(got.get("--pr"));
  const head = got.get("--head") ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { ok: false, error: `--repo must be owner/name. ${USAGE}` };
  if (!Number.isInteger(issue) || issue <= 0) return { ok: false, error: `--issue must be a positive whole number. ${USAGE}` };
  if (!Number.isInteger(pr) || pr <= 0) return { ok: false, error: `--pr must be a positive whole number. ${USAGE}` };
  if (!/^[0-9a-f]{40}$/.test(head)) return { ok: false, error: `--head must be a full 40-character lowercase sha. ${USAGE}` };
  if (!got.has("--verdict")) return { ok: false, error: `--verdict is required. ${USAGE}` };
  return { ok: true, value: { repo, issue, pr, head, verdict: got.get("--verdict") ?? "" } };
}

interface PrFacts {
  state: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  url: string;
  title: string;
}

async function ghJson(gh: GhRunner, endpoint: string): Promise<unknown> {
  const r = await gh(["api", endpoint]);
  if (r.code !== 0) throw new Error(`gh api ${endpoint} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    throw new Error(`gh api ${endpoint} returned output that is not JSON`);
  }
}

async function readPr(gh: GhRunner, repo: string, pr: number): Promise<PrFacts> {
  const p = (await ghJson(gh, `repos/${repo}/pulls/${pr}`)) as { state?: unknown; title?: unknown; html_url?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown } };
  const baseRef = p.base?.ref;
  if (typeof p.state !== "string" || typeof p.head?.sha !== "string" || typeof baseRef !== "string" || typeof p.html_url !== "string") {
    throw new Error("the pull request response lacks state, head, base or url");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(baseRef)) throw new Error("the base branch name is not a plain ref");
  // The PR's own base.sha is where it branched; the tip of the base branch is what a merge lands on (as coding-callbacks-live.ts reads it).
  const ref = (await ghJson(gh, `repos/${repo}/git/ref/heads/${baseRef}`)) as { object?: { sha?: unknown } };
  if (typeof ref.object?.sha !== "string" || !/^[0-9a-f]{40}$/.test(ref.object.sha)) throw new Error("the base branch tip is not a sha");
  return { state: p.state, headSha: p.head.sha, baseRef, baseSha: ref.object.sha, url: p.html_url, title: typeof p.title === "string" ? p.title : "" };
}

export async function runEvidenceCard(argv: string[], env: Record<string, string | undefined>, deps: EvidenceCardDeps): Promise<string> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return failed(parsed.error);
  const a = parsed.value;
  const decision = reviewDecisionOf(a.verdict);
  if (decision !== "APPROVE") return line({ status: "NONE", reason: `the review did not clear PR #${a.pr} (${decision})` });
  const gh = readOnlyGh(deps.gh);

  let facts: PrFacts;
  try {
    facts = await readPr(gh, a.repo, a.pr);
  } catch (err) {
    return failed(errText(err));
  }
  if (facts.state !== "open") return failed(`PR #${a.pr} is ${facts.state}, not open`);
  if (facts.headSha !== a.head) return failed(`the head moved while the review ran (reviewed ${a.head.slice(0, 7)}, now ${facts.headSha.slice(0, 7)}); the new head needs its own review`);

  const checks = await gh(["pr", "checks", String(a.pr), "--repo", a.repo, "--required", "--json", "bucket,name"]);
  const ci = requiredCiVerdict(checks.stdout.trim() ? checks.stdout : checks.stderr, a.head);
  const review = { decision, head_sha: a.head };
  const gate = canMerge({ evidence: ci, review, headAtReview: a.head, headNow: facts.headSha, baseAtReview: facts.baseSha, baseNow: facts.baseSha });
  const nonce = deps.nonce();

  let card;
  try {
    card = renderEvidenceCard({
      ci,
      review: { decision, findings: [] },
      merge: gate,
      prUrl: facts.url,
      nonce,
      subject: { repo: a.repo, pr: a.pr, issue: a.issue, title: facts.title },
    });
  } catch (err) {
    return failed("card: " + errText(err));
  }
  const markup = { inline_keyboard: card.keyboard.inline_keyboard };
  const mergeable = ci.status === "PASS" && gate.ok;
  if (mergeable) {
    const written = await writePending(deps.fs, contractsDir(env), {
      kind: "merge",
      nonce,
      repo: a.repo,
      issue: a.issue,
      pr: a.pr,
      evidence: ci,
      review,
      head_at_review: a.head,
      base_at_review: facts.baseSha,
      created_at: deps.now().toISOString(),
    });
    if (!written.ok) return failed("the merge record was not written: " + written.error);
  }
  return line({ status: "CARD", nonce, parts: card.html, reply_markup: markup, mergeable });
}

const realFs: StoreFs = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, d) => fsp.writeFile(p, d),
  rename: (a, b) => fsp.rename(a, b),
  mkdir: async (p, o) => {
    await fsp.mkdir(p, o);
  },
  rm: (p) => fsp.rm(p, { recursive: true, force: true }),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEvidenceCard(process.argv.slice(2), process.env, { fs: realFs, gh: execGh, nonce: newNonce, now: () => new Date() })
    .catch((err: unknown) => failed("unexpected: " + errText(err)))
    .then((out) => {
      process.stdout.write(out);
      process.exit(0);
    });
}
