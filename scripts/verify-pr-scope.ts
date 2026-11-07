/**
 * verify-pr-scope — a PR that adds a code or script file must say what was checked first.
 *
 * Checked first (founder 2026-10-13, permanent): the PR body's `Checked first:` line names what existing code,
 * framework or product feature was searched, and what was found. Agents kept building what already existed
 * (OpenDots had scheduled tasks and computers before team-shift re-built them) and lost days to it.
 *
 * The 30-day freeze (plan 2026-10-02 → 11-01) and its `Moves:` line ended on 2026-11-01 and were removed 2026-11-07.
 * Sync/promotion PRs (head `main`, `beta`, `chore/promote-*` or `chore/sync-*`) are exempt: their content passed this
 * check on the way in. Runs from .github/workflows/pr-scope.yml, which also fires on body edits.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const EXEMPT_HEADS: readonly string[] = ["main", "beta"];
// Promotions are built as origin/main + beta on chore/promote-* (AGENTS.md, 2026-10-02).
const EXEMPT_HEAD_PREFIXES: readonly string[] = ["chore/promote-", "chore/sync-"];

/** The text after `Checked first:`, HTML comments stripped so the template placeholder never counts. */
export function parseCheckedFirst(body: string): string {
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  return /^\s*checked first\s*:\s*(.*)$/im.exec(text)?.[1]?.trim() ?? "";
}

/** Added files that are new code or scripts: tests, docs and markdown never need a Checked first line. */
export function newBuildFiles(added: readonly string[]): string[] {
  return added.filter((f) => !/^(tests|docs|governance)\//.test(f) && !f.endsWith(".md"));
}

export interface PrScopeInput {
  body: string;
  headRef: string;
  /** Files the PR adds (git diff --diff-filter=A). */
  added: readonly string[];
}

export function evaluatePrScope(input: PrScopeInput): { ok: boolean; problems: string[] } {
  if (EXEMPT_HEADS.includes(input.headRef) || EXEMPT_HEAD_PREFIXES.some((p) => input.headRef.startsWith(p))) return { ok: true, problems: [] };
  const problems: string[] = [];
  const built = newBuildFiles(input.added);
  if (built.length > 0 && parseCheckedFirst(input.body).length < 20) {
    problems.push(
      `This PR adds new files:\n${built.map((f) => `  - ${f}`).join("\n")}\n` +
        "Add a `Checked first:` line: what you searched before building (repo grep, the framework or product's own " +
        "features, open issues) and what you found, so nothing that already exists gets built again.",
    );
  }
  return { ok: problems.length === 0, problems };
}

interface PrEvent {
  pull_request?: { body?: string | null; head: { ref: string }; base: { sha: string } };
}

const isMain = process.argv[1]?.endsWith("verify-pr-scope.ts");
if (isMain) {
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  const pr = eventPath ? (JSON.parse(readFileSync(eventPath, "utf8")) as PrEvent).pull_request : undefined;
  if (!pr) {
    console.log("verify-pr-scope: not a pull_request event — nothing to check.");
    process.exit(0);
  }
  const added = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", `${pr.base.sha}...HEAD`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const result = evaluatePrScope({ added, body: pr.body ?? "", headRef: pr.head.ref });
  if (result.ok) {
    console.log(`✓ PR scope: ${added.length} added file(s), ${newBuildFiles(added).length} need Checked first`);
    process.exit(0);
  }
  for (const p of result.problems) console.error(`✗ ${p}`);
  process.exit(1);
}
