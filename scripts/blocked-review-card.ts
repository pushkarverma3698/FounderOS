/**
 * The card for a PR pr-brain just blocked, for deploy/vps-daemons/pr-brain. Bash does the Telegram send; the judgement
 * (is there a blocking verdict for this exact head, is the PR still an open draft, which issue does it answer, what does
 * the card print, what does a tap act on) is made here, by the pure functions in src/tools/ and src/gateway/.
 *
 *   node --import tsx/esm scripts/blocked-review-card.ts --repo owner/name --pr P --head SHA
 *     -> {"status":"NONE","reason"}                  nothing to show: no blocking verdict for this head, PR not an open draft
 *      | {"status":"CARD","nonce","parts":[html..],"reply_markup"}
 *      | {"status":"FAILED","error"}                 could not read GitHub or write the record: the caller sends its plain message
 *
 * Always exits 0 and prints one JSON line. Independent of AGENT_PIPELINE_V2: a blocked PR is blocked on every path.
 * Read-only on GitHub (readOnlyGh). The only write is the "fix" pending record the [Fix now] / [Close PR] buttons point at,
 * and it is written only when a card is returned, so a card never has buttons that point at nothing.
 *
 * Oplify PR #116, 2026-10-09: pr-brain blocked it with two blockers; the founder got a one-line "CHANGES REQUESTED" and
 * no way to act on it from the phone.
 */
import * as fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { renderBlockedCard } from "../src/gateway/blocked-card.js";
import { contractsDir, newNonce, writePending, type StoreFs } from "../src/tools/pipeline-pending.js";
import { blockersOf, latestVerdictForHead } from "../src/tools/pr-verdict-facts.js";
import { execGh, readOnlyGh, type GhRunner } from "./gh-read.js";

export interface BlockedCardDeps {
  fs: StoreFs;
  gh: GhRunner;
  nonce: () => string;
  now: () => Date;
}

const USAGE = "usage: blocked-review-card.ts --repo owner/name --pr P --head SHA";
const line = (v: unknown): string => JSON.stringify(v) + "\n";
const failed = (error: string): string => line({ status: "FAILED", error });
const none = (reason: string): string => line({ status: "NONE", reason });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Args {
  repo: string;
  pr: number;
  head: string;
}

function parseArgs(argv: string[]): { ok: true; value: Args } | { ok: false; error: string } {
  const got = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i] as string;
    const v = argv[i + 1];
    if (!["--repo", "--pr", "--head"].includes(k) || v === undefined || got.has(k)) return { ok: false, error: `bad argument ${k}. ${USAGE}` };
    got.set(k, v);
  }
  const repo = got.get("--repo") ?? "";
  const pr = Number(got.get("--pr"));
  const head = got.get("--head") ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { ok: false, error: `--repo must be owner/name. ${USAGE}` };
  if (!Number.isInteger(pr) || pr <= 0) return { ok: false, error: `--pr must be a positive whole number. ${USAGE}` };
  if (!/^[0-9a-f]{40}$/.test(head)) return { ok: false, error: `--head must be a full 40-character lowercase sha. ${USAGE}` };
  return { ok: true, value: { repo, pr, head } };
}

async function ghJson(gh: GhRunner, args: string[]): Promise<unknown> {
  const r = await gh(["api", ...args]);
  const endpoint = args.find((a) => a.startsWith("repos/")) ?? "";
  if (r.code !== 0) throw new Error(`gh api ${endpoint} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    throw new Error(`gh api ${endpoint} returned output that is not JSON`);
  }
}

interface PrFacts {
  state: string;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  title: string;
  url: string;
}

async function readPr(gh: GhRunner, repo: string, pr: number): Promise<PrFacts> {
  const p = (await ghJson(gh, [`repos/${repo}/pulls/${pr}`])) as {
    state?: unknown;
    draft?: unknown;
    title?: unknown;
    html_url?: unknown;
    head?: { sha?: unknown; ref?: unknown };
    base?: { ref?: unknown };
  };
  if (typeof p.state !== "string" || typeof p.head?.sha !== "string" || typeof p.head.ref !== "string" || typeof p.base?.ref !== "string" || typeof p.html_url !== "string") {
    throw new Error("the pull request response lacks state, head, base or url");
  }
  return { state: p.state, draft: p.draft === true, headSha: p.head.sha, headRef: p.head.ref, baseRef: p.base.ref, title: typeof p.title === "string" ? p.title : "", url: p.html_url };
}

/** Every comment body on the PR, oldest first (pr-brain's review is one of them). */
async function readComments(gh: GhRunner, repo: string, pr: number): Promise<string[]> {
  const raw = await ghJson(gh, ["--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments?per_page=100`]);
  const pages = Array.isArray(raw) ? raw : [];
  const flat = pages.flatMap((page) => (Array.isArray(page) ? page : [page]));
  return flat.map((c) => (c && typeof (c as { body?: unknown }).body === "string" ? ((c as { body: string }).body) : ""));
}

/** The issue number of task/issue-N or task/issue-N-slug, as deploy/lib/evidence-card.sh ec_issue_of reads it. */
export function issueOfBranch(branch: string): number | undefined {
  const m = /^task\/issue-([1-9][0-9]*)(?:-|$)/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

export async function runBlockedCard(argv: string[], env: Record<string, string | undefined>, deps: BlockedCardDeps): Promise<string> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return failed(parsed.error);
  const a = parsed.value;

  let facts: PrFacts;
  let bodies: string[];
  try {
    facts = await readPr(deps.gh, a.repo, a.pr);
    bodies = await readComments(deps.gh, a.repo, a.pr);
  } catch (err) {
    return failed(errText(err));
  }
  if (facts.state !== "open") return none(`PR #${a.pr} is ${facts.state}`);
  if (facts.headSha !== a.head) return none(`the head moved (reviewed ${a.head.slice(0, 7)}, now ${facts.headSha.slice(0, 7)}); the new head needs its own review`);
  if (!facts.draft) return none(`PR #${a.pr} is not a draft`);

  const verdict = latestVerdictForHead(bodies, a.head);
  if (!verdict) return none(`no verdict for ${a.head.slice(0, 7)} on the PR`);
  const blockers = blockersOf(verdict);
  if (verdict.decision !== "REQUEST_CHANGES" || blockers.length === 0) return none(`the verdict is ${verdict.decision} with ${blockers.length} blockers`);

  const issue = issueOfBranch(facts.headRef);
  const nonce = deps.nonce();
  let card;
  try {
    card = renderBlockedCard({
      repo: a.repo,
      pr: a.pr,
      issue,
      title: facts.title,
      branch: facts.headRef,
      baseRef: facts.baseRef,
      blockers,
      otherCount: verdict.findings.length - blockers.length,
      url: facts.url,
      nonce,
    });
  } catch (err) {
    return failed("card: " + errText(err));
  }
  const written = await writePending(deps.fs, contractsDir(env), {
    kind: "fix",
    nonce,
    repo: a.repo,
    pr: a.pr,
    ...(issue !== undefined ? { issue } : {}),
    head: a.head,
    branch: facts.headRef,
    blockers: blockers.length,
    created_at: deps.now().toISOString(),
  });
  if (!written.ok) return failed("the fix record was not written: " + written.error);
  return line({ status: "CARD", nonce, parts: card.html, reply_markup: { inline_keyboard: card.keyboard.inline_keyboard } });
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
  runBlockedCard(process.argv.slice(2), process.env, { fs: realFs, gh: readOnlyGh(execGh), nonce: newNonce, now: () => new Date() })
    .catch((err: unknown) => failed("unexpected: " + errText(err)))
    .then((out) => {
      process.stdout.write(out);
      process.exit(0);
    });
}
