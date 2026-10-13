/**
 * verify-pr-scope — the 30-day hard freeze as a CI check (plan 2026-10-02 → 11-01).
 *
 * WHY: five months, 1,112 commits, 40% of them fixes, near-zero output. Each new feature
 * brought bugs the next PR fixed, and that read as progress. For 30 days every PR must
 * name which founder outcome it moves, and modules outside those outcomes are frozen:
 *   A  coding pipeline → production-ready PRs      B  "where are we" status
 *   C  jobs (works; routing only)                  D  free OpenRouter model switch
 *
 * A frozen path passes only with a label a reviewer can see: `crash-fix` (it is broken in
 * prod) or `unfreeze` (the change is named in the approved plan). Sync/promotion PRs
 * (head `main`, `beta`, `chore/promote-*` or `chore/sync-*`) are exempt — their content passed this check on the way in.
 *
 * Checked first (founder 2026-10-13, permanent): a PR that adds a code or script file must say on a `Checked first:`
 * line what existing code, framework or product feature was searched, and what was found. Agents kept building what
 * already existed (OpenDots had scheduled tasks and computers before team-shift re-built them) and lost days to it.
 *
 * Runs from .github/workflows/pr-scope.yml, which also fires on label and body edits.
 * When the freeze ends (2026-11-01), delete the Moves and frozen-path checks; keep Checked first.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const OUTCOMES = ["A", "B", "C", "D"] as const;
// `unfreeze` is founder-approved work outside A–D; it counts only with the `unfreeze` label (evaluatePrScope).
export type Move = (typeof OUTCOMES)[number] | "crash-fix" | "unfreeze";

/** Path prefixes under the freeze. Prefix match, so `src/tools/video-` covers every video-* tool. */
export const FROZEN_PREFIXES: readonly string[] = [
  "src/tools/video-",
  "src/tools/cinematic-",
  "src/tools/linkedin",
  "src/tools/gap-scan",
  "src/tools/skill-synthesizer",
  "src/tools/image-gen",
  "src/tools/tts",
  "src/tools/transcription",
  "src/tools/apify",
  "src/tools/opencode",
  "src/tools/scheduled-post",
  "src/tools/deploy-static-site",
  "src/tools/jobhunt/",
  "src/evolution/",
  "src/proof/",
  "src/mcp/",
  "video-factory/",
  "mac-client/",
];

export const PASS_LABELS: readonly string[] = ["crash-fix", "unfreeze"];
const EXEMPT_HEADS: readonly string[] = ["main", "beta"];
// Promotions are built as origin/main + beta on chore/promote-* (AGENTS.md, 2026-10-02); pr-brain skips the same heads.
const EXEMPT_HEAD_PREFIXES: readonly string[] = ["chore/promote-", "chore/sync-"];

/** Outcomes named on a `Moves:` line. HTML comments are stripped first so the template placeholder never counts. */
export function parseMoves(body: string): Move[] {
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  const line = /^\s*moves\s*:\s*(.+)$/im.exec(text);
  if (!line) return [];
  const out: Move[] = [];
  for (const raw of line[1]!.split(/[\s,/|]+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    if (tok.toLowerCase() === "crash-fix") out.push("crash-fix");
    else if (tok.toLowerCase() === "unfreeze") out.push("unfreeze");
    else if ((OUTCOMES as readonly string[]).includes(tok.toUpperCase())) out.push(tok.toUpperCase() as Move);
  }
  return [...new Set(out)];
}

/** The text after `Checked first:`, HTML comments stripped so the template placeholder never counts. */
export function parseCheckedFirst(body: string): string {
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  return /^\s*checked first\s*:\s*(.*)$/im.exec(text)?.[1]?.trim() ?? "";
}

/** Added files that are new code or scripts: tests, docs and markdown never need a Checked first line. */
export function newBuildFiles(added: readonly string[]): string[] {
  return added.filter((f) => !/^(tests|docs|governance)\//.test(f) && !f.endsWith(".md"));
}

export function frozenTouches(files: readonly string[]): string[] {
  return files.filter((f) => FROZEN_PREFIXES.some((p) => f.startsWith(p)));
}

export interface PrScopeInput {
  files: readonly string[];
  body: string;
  labels: readonly string[];
  headRef: string;
  /** Files the PR adds (git diff --diff-filter=A). */
  added?: readonly string[];
}

export function evaluatePrScope(input: PrScopeInput): { ok: boolean; problems: string[] } {
  if (EXEMPT_HEADS.includes(input.headRef) || EXEMPT_HEAD_PREFIXES.some((p) => input.headRef.startsWith(p))) return { ok: true, problems: [] };
  const problems: string[] = [];
  if (parseMoves(input.body).length === 0) {
    problems.push(
      "The PR body has no `Moves:` line. Add one naming the outcome this PR moves: " +
        "`Moves: A` (coding PRs), `B` (status), `C` (jobs), `D` (model switch), or `Moves: crash-fix`.",
    );
  } else if (parseMoves(input.body).includes("unfreeze") && !input.labels.includes("unfreeze")) {
    problems.push("`Moves: unfreeze` needs the `unfreeze` label: only the founder approves work outside outcomes A–D.");
  }
  const built = newBuildFiles(input.added ?? []);
  if (built.length > 0 && parseCheckedFirst(input.body).length < 20) {
    problems.push(
      `This PR adds new files:\n${built.map((f) => `  - ${f}`).join("\n")}\n` +
        "Add a `Checked first:` line: what you searched before building (repo grep, the framework or product's own " +
        "features, open issues) and what you found, so nothing that already exists gets built again.",
    );
  }
  const frozen = frozenTouches(input.files);
  if (frozen.length > 0 && !input.labels.some((l) => PASS_LABELS.includes(l))) {
    problems.push(
      `This PR changes frozen paths (30-day freeze, plan 2026-10-02):\n${frozen.map((f) => `  - ${f}`).join("\n")}\n` +
        "Allowed only with a label: `crash-fix` (broken in prod) or `unfreeze` (named in the approved plan).",
    );
  }
  return { ok: problems.length === 0, problems };
}

interface PrEvent {
  pull_request?: { body?: string | null; labels?: Array<{ name: string }>; head: { ref: string }; base: { sha: string } };
}

const isMain = process.argv[1]?.endsWith("verify-pr-scope.ts");
if (isMain) {
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  const pr = eventPath ? (JSON.parse(readFileSync(eventPath, "utf8")) as PrEvent).pull_request : undefined;
  if (!pr) {
    console.log("verify-pr-scope: not a pull_request event — nothing to check.");
    process.exit(0);
  }
  const files = execFileSync("git", ["diff", "--name-only", `${pr.base.sha}...HEAD`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const added = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", `${pr.base.sha}...HEAD`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const result = evaluatePrScope({
    files,
    added,
    body: pr.body ?? "",
    labels: (pr.labels ?? []).map((l) => l.name),
    headRef: pr.head.ref,
  });
  if (result.ok) {
    console.log(`✓ PR scope: ${files.length} file(s), moves ${parseMoves(pr.body ?? "").join(", ") || "(exempt)"}`);
    process.exit(0);
  }
  for (const p of result.problems) console.error(`✗ ${p}`);
  process.exit(1);
}
