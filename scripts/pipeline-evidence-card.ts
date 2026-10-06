/**
 * The evidence card for one reviewed pipeline PR, for deploy/vps-daemons/pr-brain. Bash does the Telegram send; every
 * judgement (is there a contract, what do the checks say, may this head be merged, what does the card print, what does a
 * tap act on) is made here, by the pure functions in src/tools/ and src/gateway/coding-cards.ts.
 *
 *   node --import tsx/esm scripts/pipeline-evidence-card.ts --repo owner/name --issue N --pr P --head SHA --verdict TEXT
 *     -> {"status":"DISABLED"}                                   flag off: nothing read, nothing written
 *      | {"status":"NONE"}                                       no contract for the issue: a legacy PR, old path
 *      | {"status":"INVALID","error"}                            a contract exists but cannot be read: HOLD the merge
 *      | {"status":"CARD","nonce","parts":[html..],"reply_markup","mergeable"}
 *      | {"status":"FAILED","error"}                             could not build the card: HOLD the merge
 *
 * --head is the PR head pr-brain reviewed; --verdict is pr-brain's own verdict line. Always exits 0 and prints one JSON line.
 * Steps: read the approved contract; read the PR and the base tip from GitHub; refuse if the head is not the reviewed one;
 * bind the contract to the PR; get the two evidence verdicts (spec red, implementation green); run canMerge on them; render
 * the card; write the merge record the [Merge] button points at, but ONLY when a merge button is on the card.
 */
import * as fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { renderEvidenceCard } from "../src/gateway/coding-cards.js";
import { contractsDir, readContractRecord, writeContractRecord, type StoreFs } from "../src/tools/contract-store.js";
import { notVerifiedFor, readVerdict, reviewDecisionOf } from "../src/tools/pipeline-evidence-card.js";
import { newNonce, pipelineV2Enabled, writePending } from "../src/tools/pipeline-pending.js";
import { canMerge } from "../src/tools/pr-evidence.js";
import { execGh, readOnlyGh, runPrEvidence, type CliFs, type GhRunner } from "./pr-evidence.js";

export interface EvidenceCardDeps {
  fs: StoreFs;
  gh: GhRunner;
  nonce: () => string;
  now: () => Date;
  /** One evidence verdict (the JSON scripts/pr-evidence.ts prints) for "spec" or "green". May throw. */
  evidence: (mode: "spec" | "green") => Promise<unknown>;
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
  const p = (await ghJson(gh, `repos/${repo}/pulls/${pr}`)) as { state?: unknown; html_url?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown } };
  const baseRef = p.base?.ref;
  if (typeof p.state !== "string" || typeof p.head?.sha !== "string" || typeof baseRef !== "string" || typeof p.html_url !== "string") {
    throw new Error("the pull request response lacks state, head, base or url");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(baseRef)) throw new Error("the base branch name is not a plain ref");
  // The PR's own base.sha is where it branched; the tip of the base branch is what a merge lands on (as coding-callbacks-live.ts reads it).
  const ref = (await ghJson(gh, `repos/${repo}/git/ref/heads/${baseRef}`)) as { object?: { sha?: unknown } };
  if (typeof ref.object?.sha !== "string" || !/^[0-9a-f]{40}$/.test(ref.object.sha)) throw new Error("the base branch tip is not a sha");
  return { state: p.state, headSha: p.head.sha, baseRef, baseSha: ref.object.sha, url: p.html_url };
}

export async function runEvidenceCard(argv: string[], env: Record<string, string | undefined>, deps: EvidenceCardDeps): Promise<string> {
  if (!pipelineV2Enabled(env)) return line({ status: "DISABLED" });
  const parsed = parseArgs(argv);
  if (!parsed.ok) return failed(parsed.error);
  const a = parsed.value;
  const dir = contractsDir(env);

  const stored = await readContractRecord(deps.fs, dir, a.repo, a.issue);
  if (!stored.ok) return stored.code === "not_found" ? line({ status: "NONE" }) : line({ status: "INVALID", error: stored.error });
  const rec = stored.value;
  if (rec.pr !== undefined && rec.pr !== a.pr) return failed(`the approved contract for #${a.issue} is bound to PR #${rec.pr}, not PR #${a.pr}`);

  let facts: PrFacts;
  try {
    facts = await readPr(deps.gh, a.repo, a.pr);
  } catch (err) {
    return failed(errText(err));
  }
  if (facts.state !== "open") return failed(`PR #${a.pr} is ${facts.state}, not open`);
  if (facts.headSha !== a.head) return failed(`the head moved while the review ran (reviewed ${a.head.slice(0, 7)}, now ${facts.headSha.slice(0, 7)}); the new head needs its own review`);

  if (rec.pr === undefined) {
    const bound = await writeContractRecord(deps.fs, dir, { ...rec, pr: a.pr });
    if (!bound.ok) return failed(`could not bind the contract to PR #${a.pr}: ${bound.error}`);
  }

  // Red-before is judged at the spec commit, not at the PR head.
  const specCommit = rec.spec_commit ?? rec.contract.spec_commit;
  if (!specCommit) return failed(`the approved contract for #${a.issue} has no spec_commit`);
  const spec = await verdictOf(deps, "spec", specCommit);
  const green = await verdictOf(deps, "green", a.head);
  const decision = reviewDecisionOf(a.verdict);
  const review = { decision, head_sha: a.head };
  const gate = canMerge({ evidence: green, review, headAtReview: a.head, headNow: facts.headSha, baseAtReview: facts.baseSha, baseNow: facts.baseSha });
  const notVerified = notVerifiedFor(rec.contract);
  const nonce = deps.nonce();

  let card;
  try {
    card = renderEvidenceCard({
      spec,
      green,
      review: { decision, findings: [] },
      merge: gate,
      notVerified,
      prUrl: facts.url,
      nonce,
    });
  } catch (err) {
    return failed("card: " + errText(err));
  }
  const markup = { inline_keyboard: card.keyboard.inline_keyboard };
  const mergeable = spec.status === "PASS" && green.status === "PASS" && decision === "APPROVE" && gate.ok;
  if (mergeable) {
    const written = await writePending(deps.fs, dir, {
      kind: "merge",
      nonce,
      repo: a.repo,
      issue: a.issue,
      pr: a.pr,
      evidence: green,
      review,
      head_at_review: a.head,
      base_at_review: facts.baseSha,
      created_at: deps.now().toISOString(),
    });
    if (!written.ok) return failed("the merge record was not written: " + written.error);
  }
  return line({ status: "CARD", nonce, parts: card.html, reply_markup: markup, mergeable });
}

async function verdictOf(deps: EvidenceCardDeps, mode: "spec" | "green", head: string) {
  try {
    return readVerdict(await deps.evidence(mode), head);
  } catch (err) {
    // allow-failopen: a run that crashed becomes an UNKNOWN row on the card, which never carries a merge button
    return { status: "UNKNOWN" as const, reasons: [`the ${mode} evidence run failed: ${errText(err)}`], head_sha: head };
  }
}

const realFs: CliFs = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, d) => fsp.writeFile(p, d),
  rename: (a, b) => fsp.rename(a, b),
  mkdir: async (p, o) => {
    await fsp.mkdir(p, o);
  },
  rm: (p) => fsp.rm(p, { recursive: true, force: true }),
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const gh = readOnlyGh(execGh);
  const issue = argv[argv.indexOf("--issue") + 1] ?? "";
  const repo = argv[argv.indexOf("--repo") + 1] ?? "";
  const pr = argv[argv.indexOf("--pr") + 1] ?? "";
  const evidence = async (mode: "spec" | "green"): Promise<unknown> => {
    const args = ["--repo", repo, "--issue", issue, "--mode", mode, ...(mode === "green" ? ["--pr", pr] : [])];
    const r = await runPrEvidence(args, process.env, { gh: execGh, fs: realFs });
    return JSON.parse(r.stdout) as unknown;
  };
  runEvidenceCard(argv, process.env, { fs: realFs, gh, nonce: newNonce, now: () => new Date(), evidence })
    .catch((err: unknown) => failed("unexpected: " + errText(err)))
    .then((out) => {
      process.stdout.write(out);
      process.exit(0);
    });
}
