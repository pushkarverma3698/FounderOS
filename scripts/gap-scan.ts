/**
 * FounderOS — AI Visibility Gap Scan CLI (lead-acquisition spec, Phase 0)
 * ========================================================================
 * Run one account scan from the command line and write the two artifacts the
 * outreach motion needs: the raw JSON (learning-loop schema §11) and the
 * rendered 1-page Markdown gap report (§3.4).
 *
 *   pnpm gap:scan -- \
 *     --name Acme --domain acme.com --category "CRM for SMBs" \
 *     --competitors "HubSpot=hubspot.com, Close=close.com" \
 *     [--runs 5] [--max-prompts 25] [--segments "startups,agencies"] \
 *     [--out reports/gap-scans]
 *
 * Requires GOOGLE_GENERATIVE_AI_API_KEY and/or OPENROUTER_API_KEY in .env.
 * Exits non-zero on failure (fail loud — this is a founder-facing artifact).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDefaultSurfaces, parseCompetitors, runGapScan } from "../src/tools/gap-scanner.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const name = flag("name");
  const domain = flag("domain");
  const category = flag("category");
  const competitorsRaw = flag("competitors");
  if (!name || !domain || !category || !competitorsRaw) {
    console.error(
      'Usage: pnpm gap:scan -- --name Acme --domain acme.com --category "CRM" --competitors "HubSpot=hubspot.com, Close=close.com" [--runs 5] [--max-prompts 25] [--segments "a,b"] [--out reports/gap-scans]',
    );
    process.exit(1);
  }

  const competitors = parseCompetitors(competitorsRaw);
  if (competitors.length < 1 || competitors.length > 5) {
    console.error(`--competitors must contain 1-5 'Name=domain' pairs (got ${competitors.length}).`);
    process.exit(1);
  }

  const surfaces = buildDefaultSurfaces();
  if (surfaces.length === 0) {
    console.error(
      "No AI surfaces configured. Set GOOGLE_GENERATIVE_AI_API_KEY and/or OPENROUTER_API_KEY (optionally GAP_SCAN_SURFACES) in .env.",
    );
    process.exit(1);
  }

  const runs = Number(flag("runs") ?? 5);
  const maxPrompts = Number(flag("max-prompts") ?? 25);
  const segmentsRaw = flag("segments");
  const outDir = flag("out") ?? join("reports", "gap-scans");

  console.log(
    `Scanning ${name} (${domain}) vs ${competitors.map((c) => c.name).join(", ")} on [${surfaces.map((s) => s.id).join(", ")}] — ${runs} runs/prompt…`,
  );
  const started = Date.now();
  const { report, insights, markdown } = await runGapScan(
    {
      target: { name, domain },
      competitors,
      category,
      runsPerPrompt: runs,
      maxPrompts,
      ...(segmentsRaw ? { segments: segmentsRaw.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    },
    surfaces,
  );

  if (report.runs_completed === 0) {
    console.error(`All ${report.runs_total} surface calls failed — check API keys/quota.`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const stamp = report.generated_at.slice(0, 10);
  const base = join(outDir, `${report.target.domain.replace(/[^a-z0-9.-]/gi, "_")}-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify({ report, insights }, null, 2) + "\n");
  writeFileSync(`${base}.md`, markdown);

  // Persist to gap_scans when a DB is configured (agents retrieve via get_gap_scans).
  let savedLine = "not saved (DATABASE_URL not set)";
  if (process.env["DATABASE_URL"]) {
    try {
      const { saveGapScan } = await import("../src/db/gap-scan-queries.js");
      const id = await saveGapScan({
        target_name: report.target.name,
        target_domain: report.target.domain,
        category: report.category,
        gap_score: report.gap_score,
        confidence: insights.confidence.grade,
        completion_rate: String(report.completion_rate),
        runs_total: report.runs_total,
        surfaces: report.surfaces,
        report: report as unknown as Record<string, unknown>,
        insights: insights as unknown as Record<string, unknown>,
        markdown,
      });
      savedLine = `saved to gap_scans as ${id}`;
    } catch (err) {
      savedLine = `DB save FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const target = report.companies[0]!;
  console.log(`\nGap Score: ${report.gap_score}/100  (${((Date.now() - started) / 1000).toFixed(0)}s) · confidence ${insights.confidence.grade}`);
  console.log(`Completion: ${report.runs_completed}/${report.runs_total} (${Math.round(report.completion_rate * 100)}%)`);
  console.log(`Target appearance: ${Math.round(target.appearance_rate * 100)}% · cited: ${Math.round(target.cited_rate * 100)}%`);
  console.log(`Share-of-answer rank: ${report.share_of_answer_rank.join(" > ")}`);
  console.log(`Lost answers: ${insights.stake.lost_answers}/${insights.stake.completed} named a competitor without ${report.target.name}`);
  for (const t of insights.threats) console.log(`Threat: ${t.name} — ${t.threat} (index ${t.threat_index})`);
  for (const c of [...report.causes, ...insights.additional_causes]) console.log(`Cause: ${c.cause}`);
  console.log(`\nDB: ${savedLine}`);
  console.log(`Artifacts:\n  ${base}.json\n  ${base}.md`);
}

main().catch((err) => {
  console.error("Gap scan crashed:", err);
  process.exit(1);
});
