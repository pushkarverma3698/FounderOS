/**
 * FounderOS — repo status renderer (summary -> Telegram HTML). Pure.
 * One section per repo so the caller can send each as its own message (4096-char limit).
 */

import type { RepoSummary, Item } from "./repo-status.js";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const link = (i: Item): string => `<a href="${esc(i.url)}">#${i.number}</a> ${esc(i.title.slice(0, 70))}`;
const shown = (items: readonly Item[], max: number): string[] => {
  const rows = items.slice(0, max).map((i) => `  • ${link(i)}`);
  if (items.length > max) rows.push(`  … and ${items.length - max} more`);
  return rows;
};

export function renderRepoSection(s: RepoSummary): string {
  // "none" is the bucket for issues with no priority label. It is never printed as a word: a repo that uses no
  // priority labels gets no parenthesis (live QA 2026-10-09: "(none 38)"), a mixed one says "N unprioritised".
  const { none: unprioritised = 0, ...ranked } = s.left.byPriority;
  const prio = [
    ...Object.entries(ranked).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${esc(k)} ${v}`),
    ...(unprioritised > 0 && Object.keys(ranked).length > 0 ? [`${unprioritised} unprioritised`] : []),
  ].join(", ");
  const lines = [
    `<b>${esc(s.slug)}</b>`,
    `Done (7d): ${s.done.count}`,
    ...shown(s.done.top, 3),
    `In flight: ${s.inFlight.openPrs.length} open PRs, ${s.inFlight.agentIssues.length} agent issues`,
    ...s.inFlight.openPrs.slice(0, 5).map((p) => `  • ${link(p)}${p.draft ? " (draft)" : ""}`),
    ...shown(s.inFlight.agentIssues, 5),
    `Left: ${s.left.total} open issues${prio ? ` (${prio})` : ""}`,
    `Blocked: ${s.blocked.issues.length} issues, ${s.blocked.failingPrs.length} PRs with failing checks`,
    ...shown(s.blocked.issues, 5),
    ...s.blocked.failingPrs.slice(0, 5).map((p) => `  • ${link(p)} — failing checks`),
  ];
  return lines.join("\n");
}

export function renderWhere(
  summaries: readonly RepoSummary[],
  unreachable: readonly { repo: string; error: string }[],
): string[] {
  const parts = summaries.map(renderRepoSection);
  if (unreachable.length > 0) {
    parts.push(
      ["<b>Could not read</b>", ...unreachable.map((u) => `• ${esc(u.repo)}: ${esc(u.error.slice(0, 200))}`)].join("\n"),
    );
  }
  return parts;
}
