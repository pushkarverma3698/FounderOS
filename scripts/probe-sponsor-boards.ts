/**
 * Probe the IND recognised-sponsor register for free ATS boards
 * ================================================================
 * The free lane polls ~285 curated boards for nothing, forever. This script
 * grows that registry by checking whether each of the ~12,900 IND-recognised
 * sponsors runs a public Greenhouse/Lever/Ashby/Recruitee board — if it does,
 * that company gets added and the free lane can poll it every 30 minutes from
 * then on, no further cost.
 *
 * MEASURED, not guessed (2026-08-20, n=200-280 samples per platform set):
 *   Greenhouse + Lever + Ashby  → 0.36% hit rate (~46 boards extrapolated)
 *   Recruitee                  → the dominant hit rate in that set — Dutch
 *                                 SMEs overwhelmingly do not run US-centric
 *                                 ATS platforms
 * Personio and Homerun are NOT probed here: Personio's public XML feed
 * carries no verifiable per-posting URL (checked live against two real
 * customer boards, both redirect to personio.com's marketing page); Homerun
 * was never verified live in this pass.
 *
 * STRICT SLUGS ONLY, no first-word fallback. An early version's fallback
 * matched `lever/blue` to "Blue Ocean Engineering B.V." — a wrong board is
 * worse than no board, because a screened posting under the wrong company
 * name is a confident wrong answer nothing downstream can detect.
 *
 * This is a LONG-RUNNING, rate-limited sweep against real third-party hosts —
 * minutes for a sample, hours for the full register. Run it in the
 * background, not inline in a chat session:
 *
 *   node --import tsx/esm scripts/probe-sponsor-boards.ts                 # full run
 *   node --import tsx/esm scripts/probe-sponsor-boards.ts --limit 50      # sample
 *   node --import tsx/esm scripts/probe-sponsor-boards.ts --dry-run       # no writes
 */

import { readFileSync } from "node:fs";
import { registerPathFrom, parseSponsorCsv } from "../src/tools/jobhunt/sponsor-registry.js";
import { getFreeBoards, registerDiscoveredBoard, FREE_ATS_PLATFORMS, type FreeAts, type FreeBoard } from "../src/tools/jobhunt/free-boards.js";
import { boardUrl } from "../src/tools/jobhunt/free-ats-source.js";
import { FREE_MAPPERS } from "../src/tools/jobhunt/free-ats-mappers.js";
import { mapWithConcurrencyLimit } from "../src/core/concurrency.js";

/** Legal-entity words stripped before slugging — none of them appear in a board token. */
const LEGAL_SUFFIXES =
  /\b(b\.?\s?v\.?|n\.?\s?v\.?|holding[s]?|group|nederland|the netherlands|netherlands|international|europe)\b\.?/gi;

/**
 * The FULL name minus legal suffixes, dashed. ONE slug, not a family of
 * guesses — see the file header for why a fallback is worse than a miss.
 */
export function strictSlug(companyName: string): string {
  return companyName
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_CONCURRENCY = 10;
const PROGRESS_EVERY = 250;

interface ProbeHit {
  readonly name: string;
  readonly ats: FreeAts;
  readonly token: string;
}

async function probeOne(name: string, slug: string, ats: FreeAts): Promise<ProbeHit | null> {
  if (slug.length < 2) return null;
  const board: FreeBoard = { name, ats, token: slug, markets: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(boardUrl(board), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      void res.body?.cancel();
      return null;
    }
    const payload = await res.json();
    // A real hit, not just a 200: the board must actually parse into at
    // least one posting the same mapper the live sweep uses would accept.
    const candidates = FREE_MAPPERS[ats](payload, board);
    return candidates.length > 0 ? { name, ats, token: slug } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit"));
  const limit = limitArg ? Number(limitArg.split("=")[1] ?? args[args.indexOf(limitArg) + 1]) : undefined;
  const dryRun = args.includes("--dry-run");
  const platforms: readonly FreeAts[] = FREE_ATS_PLATFORMS;

  const csv = readFileSync(registerPathFrom(), "utf8");
  const allNames = parseSponsorCsv(csv);
  if (allNames.length < 1000) {
    throw new Error(`Sponsor register parsed only ${allNames.length} names — refusing to probe a thin register.`);
  }
  const names = limit ? allNames.slice(0, limit) : allNames;

  const known = new Set(getFreeBoards().map((b) => `${b.ats}:${b.token}`));

  // (name, slug) pairs, deduped on slug — two sponsors slugging to the same
  // string is rare but real, and probing it twice buys nothing.
  const seenSlugs = new Set<string>();
  const targets: Array<{ name: string; slug: string }> = [];
  for (const name of names) {
    const slug = strictSlug(name);
    if (slug.length < 2 || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    targets.push({ name, slug });
  }

  const jobs: Array<{ name: string; slug: string; ats: FreeAts }> = [];
  for (const { name, slug } of targets) {
    for (const ats of platforms) {
      if (known.has(`${ats}:${slug}`)) continue; // already polled — nothing to learn
      jobs.push({ name, slug, ats });
    }
  }

  console.log(
    `Probing ${targets.length} companies × ${platforms.length} platforms ` +
      `(${jobs.length} requests after skipping already-known boards)…`,
  );

  const hits: ProbeHit[] = [];
  let done = 0;
  const started = Date.now();

  await mapWithConcurrencyLimit(jobs, DEFAULT_CONCURRENCY, async (job) => {
    const hit = await probeOne(job.name, job.slug, job.ats);
    done++;
    if (hit) {
      hits.push(hit);
      console.log(`  ✓ ${hit.ats}/${hit.token} — ${hit.name}`);
    }
    if (done % PROGRESS_EVERY === 0) {
      const elapsedS = (Date.now() - started) / 1000;
      const rate = done / elapsedS;
      const etaS = (jobs.length - done) / Math.max(rate, 0.01);
      console.log(
        `  … ${done}/${jobs.length} checked, ${hits.length} hits, ` +
          `~${Math.round(etaS / 60)}min remaining`,
      );
    }
    return null;
  });

  console.log(`\n── ${hits.length} board(s) found ──`);
  const byPlatform = new Map<FreeAts, number>();
  for (const h of hits) byPlatform.set(h.ats, (byPlatform.get(h.ats) ?? 0) + 1);
  for (const [ats, count] of byPlatform) console.log(`  ${ats}: ${count}`);

  if (!dryRun) {
    for (const hit of hits) {
      await registerDiscoveredBoard({ name: hit.name, ats: hit.ats, token: hit.token, markets: ["NL"] });
    }
    console.log(`\nWritten to the discovered-board registry.`);
  } else {
    console.log(`\n--dry-run: nothing written.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
