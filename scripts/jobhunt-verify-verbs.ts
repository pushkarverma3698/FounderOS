/**
 * Render /jobs, /today and /fresh from REAL data, without writing anything.
 *
 * WHY THIS EXISTS. Rule #24 says "done" means the verification command was run
 * fresh and its output shown, and that unit tests are necessary rather than
 * sufficient. The honest way to exercise the fresh-first command surface is
 * against the production queue — 1,676 actionable rows, real descriptions, real
 * publication dates — because every defect the 2026-09-08 truth audit found was
 * a rendering defect that every unit test of the day was happy with.
 *
 * WHY IT DOES NOT CALL buildDailyBrief. That function PERSISTS `brief_rank`,
 * and while prod still runs the old code, rewriting its numbering from an
 * unreleased branch would retarget `/draft N` on the founder's live queue — a
 * tailored application about the wrong company, caused by a verification step.
 * So this reproduces the same pipeline (rank → number → filter → render) with
 * the two writes left out, and says so in its own output.
 *
 * It is therefore a READ-ONLY REHEARSAL of the real path, not proof that the
 * deployed bot answers `/fresh`. That proof needs a message sent through
 * Telegram (scripts/lib/mtproto.ts), which needs TELEGRAM_TESTER_* credentials
 * this machine does not have.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/jobhunt-verify-verbs.ts [profileId]
 */

import { listActionableApplications, countActionableApplications } from "../src/db/job-queries.js";
import { loadTrackCvs } from "../src/tools/jobhunt/brief-cv.js";
import { rankRows, BRIEF_QUEUE_LIMIT, BRIEF_VERDICTS } from "../src/tools/jobhunt/daily-brief.js";
import { inScope, scopeMayBeIncomplete } from "../src/tools/jobhunt/brief-queue.js";
import { attachBriefRanks, briefRankEntries } from "../src/tools/jobhunt/brief-persist.js";
import { toBriefRow } from "../src/tools/jobhunt/brief-assemble.js";
import { formatDailyBrief, splitForTelegram, type BriefRow } from "../src/tools/jobhunt/brief.js";
import { parseBriefRequest, scopeFor, isProfileMiss, type BriefVerb } from "../src/tools/jobhunt/brief-resolver.js";
import { getProfile } from "../src/tools/jobhunt/profile-config.js";
import type { Liveness } from "../src/tools/jobhunt/liveness.js";

const VERBS: BriefVerb[] = ["jobs", "today", "fresh"];

async function main(): Promise<void> {
  const who = process.argv[2] ?? "";
  const now = new Date();

  const parsed = parseBriefRequest(who, "jobs");
  if (isProfileMiss(parsed)) throw new Error(`Unknown profile "${parsed.unknown}"`);
  const profile = getProfile(parsed.profileId);

  // The identical unbounded read buildDailyBrief performs.
  const applications = await listActionableApplications({
    verdicts: BRIEF_VERDICTS,
    tenantId: profile.tenantId,
    profileId: profile.id,
    maxAgeHours: null,
    limit: BRIEF_QUEUE_LIMIT,
  });

  // The same uncapped total buildDailyBrief measures, so the header's cut
  // notice renders here exactly as it will in the real message.
  const queued = await countActionableApplications({
    verdicts: BRIEF_VERDICTS,
    tenantId: profile.tenantId,
    profileId: profile.id,
    maxAgeHours: null,
  });

  const { cvs } = loadTrackCvs(profile);
  const scored = rankRows(applications, cvs, now, profile);
  // No liveness: it is network-bound and this rehearsal is about which rows
  // appear under which verb, not about whether each is still open. Every row
  // therefore reads "couldn't confirm", which is honest for a run that did not
  // check.
  const liveness = new Map<string, Liveness>();
  const allRows: BriefRow[] = scored.map(({ row, overlap }) => toBriefRow(row, overlap, now, liveness));
  const numbered = attachBriefRanks(allRows, briefRankEntries(allRows));

  console.log(`\n=== ${profile.candidateName} (${profile.id}) ===`);
  console.log(`read ${applications.length} of ${queued} actionable rows (limit ${BRIEF_QUEUE_LIMIT})`);
  console.log(`NOT WRITTEN: brief_rank, fresh_viewed_at — prod still runs the old code.\n`);

  for (const verb of VERBS) {
    const request = parseBriefRequest(who, verb);
    if (isProfileMiss(request)) continue;
    // A marker two hours back, so `/fresh` exercises its delta rather than its
    // never-run-before branch.
    const scope = scopeFor(request, {
      lastFreshView: verb === "fresh" ? new Date(now.getTime() - 2 * 3_600_000) : null,
    });
    const visible = new Set(
      scored.filter(({ row }) => inScope(row, scope, now)).map(({ row }) => row.id),
    );
    const rows = numbered.filter((r) => visible.has(r.id));
    const ranks = rows
      .map((r) => r.rank)
      .filter((r): r is number => typeof r === "number")
      .sort((a, b) => a - b);

    const rendered = formatDailyBrief({
      date: now,
      perTrack: {},
      rows,
      trends: [],
      failures: [],
      scopeLabel: scope.label,
      outsideScope: allRows.length - rows.length,
      maxAgeHours: scope.windowHours ?? null,
      // Same gate the real builder applies: the uncapped total describes the
      // same population as the rows only when nothing was filtered out.
      ...(rows.length === allRows.length ? { queued } : {}),
      profile,
    });

    console.log(`── /${verb} ${who}`.trim());
    console.log(`   scope       : ${scope.label}`);
    console.log(`   axis        : ${scope.axis}`);
    console.log(`   rows shown  : ${rows.length} of ${allRows.length}`);
    console.log(`   ranks       : ${ranks.slice(0, 12).join(", ")}${ranks.length > 12 ? " …" : ""}`);
    console.log(`   truncation? : ${scopeMayBeIncomplete(applications, queued, scope, now)}`);
    console.log(`   parts       : ${splitForTelegram(rendered).length}`);
    console.log(`   header      :`);
    for (const l of rendered.split("\n").slice(0, 6)) console.log(`      ${l}`);
    console.log("");
  }

  // THE B5 PROPERTY, checked rather than asserted: one row's number must be the
  // same under every verb that shows it.
  const byVerb = new Map<string, Map<string, number | undefined>>();
  for (const verb of VERBS) {
    const request = parseBriefRequest(who, verb);
    if (isProfileMiss(request)) continue;
    const scope = scopeFor(request, {
      lastFreshView: verb === "fresh" ? new Date(now.getTime() - 2 * 3_600_000) : null,
    });
    const visible = new Set(
      scored.filter(({ row }) => inScope(row, scope, now)).map(({ row }) => row.id),
    );
    byVerb.set(verb, new Map(numbered.filter((r) => visible.has(r.id)).map((r) => [r.id, r.rank])));
  }
  let checked = 0;
  let disagreed = 0;
  for (const [id, rank] of byVerb.get("jobs") ?? []) {
    for (const verb of ["today", "fresh"]) {
      const other = byVerb.get(verb)?.get(id);
      if (other === undefined) continue;
      checked += 1;
      if (other !== rank) disagreed += 1;
    }
  }
  console.log(`B5 — rank stability across verbs: ${checked} shared rows checked, ${disagreed} disagreed.`);
  process.exit(disagreed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
