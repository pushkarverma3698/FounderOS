/**
 * FounderOS — live proof that the multi-profile job lane actually runs
 * ===================================================================
 * `pnpm test` cannot see the defect this branch was written to fix. Every gap
 * was a missing argument on an OPTIONAL parameter, so a second candidate could
 * be fully configured, fully unit-tested, and still produce zero rows forever.
 * The only way to know is to poll real boards, screen real postings for both
 * people, and then look in the database at what landed.
 *
 * $0. The free lane's screening path imports no model (`screenPosting` is pure
 * code plus a Postgres write), and boards are polled ONCE for everybody — which
 * is the property this script exists to demonstrate.
 *
 * Run:  pnpm jobhunt:verify-multi-profile
 */

import { sweepBoards } from "../src/tools/jobhunt/free-ats-source.js";
import { getFreeBoards } from "../src/tools/jobhunt/free-boards.js";
import { runFreeIngest } from "../src/tools/jobhunt/free-ingest.js";
import { listProfiles, getProfile, type JobSearchProfile } from "../src/tools/jobhunt/profile-config.js";
import { listApplyQueue, listRecentlyScreened } from "../src/db/apply-queries.js";
import { getApplicationByBriefRank } from "../src/db/job-queries.js";
import { db } from "../src/db/client.js";
import { sql } from "drizzle-orm";

/**
 * A small, hand-picked slice of the 1,297-board registry.
 *
 * Chosen so both candidates have something to find: Optiver and Adyen post
 * finance and accounting roles, Backbase and Picnic post engineering. Running
 * the whole registry from a laptop would be 1,297 live requests to prove a
 * property that six boards prove exactly as well.
 */
const SAMPLE_TOKENS = ["adyen", "optiver", "workatbackbase", "teampicnic", "mollie", "bunq"];

/** `FULL=1` polls the whole registry — the actual production sweep, still $0. */
const FULL = process.env["FULL"] === "1";

/**
 * The free lane keeps only postings under 24h old, because in production it
 * runs every 30 minutes. Six boards on one afternoon will contain none of
 * those, and an empty funnel would prove nothing about screening. Widened here
 * so real postings actually reach the gates.
 */
const MAX_AGE_HOURS = 24 * 365;

function hr(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

/**
 * Screen ONE real Dutch employer under her actual basis and under the basis the
 * branch originally shipped, and print both gate sets.
 *
 * This is the claim that most needs evidence: the branch encoded
 * `["hsm","partner-permit"]`, which runs the IND recognised-sponsor register and
 * the salary criterion against a candidate to whom neither applies. Its own
 * end-to-end test passed because it screened her on `partner-permit` — a permit
 * she has never held. Reading the two verdicts side by side is the only way to
 * see what that would have cost.
 */
async function counterfactual(): Promise<void> {
  const { screenPosting } = await import("../src/tools/jobhunt/screen.js");
  const wife = getProfile("wife-nl-finance");
  const posting = {
    company: "Zoekjaar Counterfactual BV",
    title: "Financial Analyst",
    description:
      "We are looking for a Financial Analyst to join our Amsterdam finance team. You will own " +
      "the monthly reporting cycle, build and maintain financial models in Excel, prepare " +
      "variance analysis for the leadership team, and support the annual budgeting and FP&A " +
      "process end to end. You will work closely with the controlling team on month-end close, " +
      "reconciliations and the preparation of statutory reporting packs under IFRS. " +
      "Requirements: 2+ years of experience in finance, accounting or audit; strong Excel and " +
      "financial modelling; familiarity with ERP systems such as SAP or NetSuite; fluent " +
      "English. We are a small independent company and we do not hold a sponsor licence, so " +
      "you must already have the right to work in the Netherlands. We offer a competitive " +
      "package, 25 days of holiday, a pension scheme and a hybrid working arrangement from " +
      "our office in Amsterdam Zuid.",
    location: "Amsterdam, Netherlands",
    // Uppercase: `PostingCountry` is "NL" | "IN" | "other" | "unknown", and the
    // location gate compares exactly. Lowercase "nl" reads as `unknown` and the
    // whole posting screens as unlocated — which is what the first draft of this
    // script did, and why the counterfactual first came back on the wrong basis.
    country: "NL" as const,
    source: "verification-counterfactual",
  };

  // `permitBases` is a non-empty tuple on the schema, so each arm is written as
  // one — no cast. The middle arm is the one that shows the real cost: drop the
  // permit she does not hold and DON'T add the one she does, and what is left is
  // `hsm` — sponsor register plus salary criterion — against an employer whose
  // own ad says it has no sponsor licence.
  const arms: ReadonlyArray<readonly [string, string, [string, ...string[]]]> = [
    ["AS SHIPPED   hsm+partner-permit", "cf-as-shipped", ["hsm", "partner-permit"]],
    ["SHIPPED MINUS THE FALSE PERMIT ", "cf-hsm-only", ["hsm"]],
    ["AS FIXED     zoekjaar+hsm      ", "cf-as-fixed", ["zoekjaar", "hsm"]],
  ];

  for (const [label, id, permitBases] of arms) {
    const profile: JobSearchProfile = { ...wife, id, permitBases };
    const out = await screenPosting({
      ...posting,
      externalId: `cf-${id}-${Date.now()}`,
      profile,
    });
    if (out.kind !== "screened") {
      console.log(`  ${label} -> ${out.kind}`);
      continue;
    }
    console.log(`\n  ${label} -> ${out.verdict.status.toUpperCase()}  (route=${out.route})`);
    for (const g of out.verdict.gates) {
      console.log(`      ${g.gate.padEnd(11)} ${g.status.padEnd(6)} ${g.evidence.slice(0, 96)}`);
    }
  }
  await db.execute(sql`delete from agents.job_applications where source = 'verification-counterfactual'`);
  console.log("\n  (counterfactual rows deleted — they are not real leads)");
}

async function main(): Promise<void> {
  const profiles = listProfiles();
  hr("0. REGISTRY");
  for (const p of profiles) {
    console.log(
      `  ${p.id.padEnd(18)} bases=${p.permitBases.join("+").padEnd(20)} ` +
        `dob=${p.dob.toISOString().slice(0, 10)} tracks=${p.trackPriority.join(",")}`,
    );
  }
  if (profiles.length < 2) throw new Error("Only one profile registered — nothing to isolate.");

  const all = getFreeBoards();
  const boards = FULL ? all : all.filter((b) => SAMPLE_TOKENS.includes(b.token.toLowerCase()));
  hr(`1. ONE POLL, ${boards.length} BOARDS (shared by every profile)`);
  const t0 = Date.now();
  const sweep = await sweepBoards(boards);
  console.log(
    `  polled=${sweep.boardsPolled} candidates=${sweep.candidates.length} ` +
      `failures=${sweep.failures.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  for (const f of sweep.failures.slice(0, 5)) console.log(`  ! ${JSON.stringify(f)}`);

  hr("2. SCREEN THAT ONE POLL FOR EVERY PROFILE");
  for (const profile of profiles) {
    const result = await runFreeIngest({ profile, sweep, maxAgeHours: MAX_AGE_HOURS });
    const f = result.funnel;
    console.log(`\n  --- ${profile.id} (${profile.candidateName}) ---`);
    console.log(
      `  seen=${f.seen} stale=${f.stale} offTrack=${f.offTrack} offMarket=${f.offMarket} ` +
        `known=${f.known} bodyless=${f.bodyless} screened=${f.screened}`,
    );
    for (const note of result.notes) console.log(`  note: ${note}`);
    const byOutcome = new Map<string, number>();
    for (const l of result.lines) byOutcome.set(l.outcome, (byOutcome.get(l.outcome) ?? 0) + 1);
    console.log(`  verdicts: ${[...byOutcome].map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
    for (const line of result.lines.filter((l) => l.outcome === "pass").slice(0, 6)) {
      console.log(`   PASS  ${line.company} — ${line.title}`);
    }
    for (const line of result.lines.filter((l) => l.outcome === "flag").slice(0, 3)) {
      console.log(`   FLAG  ${line.company} — ${line.title} :: ${line.detail}`);
    }
    for (const line of result.lines.filter((l) => l.outcome === "reject").slice(0, 3)) {
      console.log(`   REJ   ${line.company} — ${line.title} :: ${line.detail}`);
    }
  }

  hr("3. WHAT ACTUALLY LANDED IN POSTGRES");
  const rows = await db.execute(
    sql`select profile_id, count(*) n, count(*) filter (where created_at > now() - interval '1 hour') fresh
        from agents.job_applications group by 1 order by 1`,
  );
  console.table(rows);

  const routes = await db.execute(
    sql`select profile_id, route, stage, count(*) n
        from agents.job_applications
        where created_at > now() - interval '2 hours'
        group by 1,2,3 order by 1,4 desc`,
  );
  console.log("\n  routes on rows created by THIS run:");
  console.table(routes);

  hr("3b. COUNTERFACTUAL — the same posting under the basis the branch shipped");
  await counterfactual();

  hr("4. CROSS-PROFILE ISOLATION (real queries, real DB)");
  for (const profile of profiles) {
    const queue = await listApplyQueue(profile.tenantId, profile.id);
    const recent = await listRecentlyScreened(profile.tenantId, profile.id, 200);
    const foreign = recent.filter((r) => r.profile_id !== profile.id);
    console.log(
      `  ${profile.id.padEnd(18)} queue=${String(queue.length).padStart(3)} ` +
        `recentlyScreened=${String(recent.length).padStart(3)} foreignRows=${foreign.length}`,
    );
    if (foreign.length > 0) throw new Error(`LEAK: ${profile.id} sees ${foreign.length} foreign rows`);
  }

  hr("5. /draft N RESOLVES PER PROFILE (the coin-flip bug)");
  for (const profile of profiles) {
    for (const section of ["do_today", "stretch"] as const) {
      const row = await getApplicationByBriefRank(section, 1, {
        tenantId: profile.tenantId,
        profileId: profile.id,
      });
      const owner = row ? row.profile_id : "—";
      console.log(
        `  ${profile.id.padEnd(18)} ${section.padEnd(9)} rank1 -> ` +
          `${row ? `${row.company} / ${row.title}` : "(no row)"} [owner=${owner}]`,
      );
      if (row && row.profile_id !== profile.id) {
        throw new Error(`LEAK: /draft ${section} 1 for ${profile.id} returned ${row.profile_id}'s row`);
      }
    }
  }

  hr("6. THE BRIEF, BUILT PER PROFILE (this is what populates brief_rank)");
  const { buildDailyBrief } = await import("../src/tools/jobhunt/daily-brief.js");
  for (const profile of profiles) {
    try {
      const brief = await buildDailyBrief({ profile });
      const named = brief.includes(profile.candidateName);
      const foreign = profiles.filter((p) => p.id !== profile.id).find((p) => brief.includes(p.candidateName));
      console.log(
        `  ${profile.id.padEnd(18)} ${String(brief.length).padStart(5)} chars  ` +
          `namesOwner=${named}  namesOther=${foreign?.candidateName ?? "no"}`,
      );
      if (foreign) throw new Error(`LEAK: ${profile.id}'s brief names ${foreign.candidateName}`);
    } catch (err) {
      // A missing CV MUST fail loudly and name HER file. The silent failure —
      // falling back to whatever CV is on disk — would tailor an application for
      // an accounting role out of a backend engineer's resume.
      const message = (err as Error).message;
      console.log(`  ${profile.id.padEnd(18)} FAILED LOUDLY: ${message.slice(0, 150)}`);
      const wrongPerson = profiles.find((p) => p.id !== profile.id && message.includes(p.baseCvPath));
      if (wrongPerson) throw new Error(`LEAK: ${profile.id} reached for ${wrongPerson.id}'s CV`);
    }
  }
  const ranked = await db.execute(
    sql`select profile_id, brief_section, count(*) n from agents.job_applications
        where brief_section is not null group by 1,2 order by 1,2`,
  );
  console.log("\n  ranked rows by profile (brief_rank populated):");
  console.table(ranked);

  hr("7. GATEWAY COMMANDS — what the founder actually types");
  const { resolveProfileArg, isProfileArgMiss } = await import("../src/gateway/jobhunt-profile-arg.js");
  for (const raw of ["", "wife", "wife 1", "3", "all", "finance", "wfie 3", "the first one", "WIFE"]) {
    const r = resolveProfileArg(raw, ["all"], (rest) => /^\d+$/.test(rest.trim()));
    console.log(
      `  /draft "${raw}"`.padEnd(28) +
        (isProfileArgMiss(r)
          ? `REFUSED (unknown "${r.unknown}") — neither queue touched`
          : `-> ${r.profile.id.padEnd(18)} rest="${r.rest}" explicit=${r.explicit}`),
    );
  }

  hr("8. /csv AND mac-client PULL THE RIGHT PERSON'S ROWS");
  const { buildJobsCsv } = await import("../src/gateway/jobhunt-view.js");
  for (const profile of profiles) {
    for (const kind of ["queue", "log"] as const) {
      const payload = await buildJobsCsv(kind, new Date(), profile.id);
      // The CSV is the founder's own eyes on the queue. A row belonging to the
      // other candidate showing up here is the same defect as `/draft` picking
      // the wrong row, just quieter.
      const foreign = profiles
        .filter((p) => p.id !== profile.id)
        .flatMap((p) => (payload.csv.includes(p.candidateName) ? [p.candidateName] : []));
      console.log(
        `  /csv ${kind.padEnd(5)} ${profile.id.padEnd(18)} rows=${String(payload.rows).padStart(3)} ` +
          `file=${payload.filename} foreignNames=${foreign.length}`,
      );
      if (foreign.length > 0) throw new Error(`LEAK: ${profile.id}'s CSV contains ${foreign.join(",")}`);
    }
  }

  const queueRows = await db.execute(
    sql`select profile_id, count(*) n from agents.job_applications
        where tenant_id='turicks' and brief_section in ('do_today','stretch')
          and applied_at is null and skipped_at is null and url is not null
        group by 1 order by 1`,
  );
  console.log("\n  what mac-client's QUEUE_SQL would see, per profile_id:");
  console.table(queueRows);

  hr("DONE — no cross-profile leak detected on live data");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
