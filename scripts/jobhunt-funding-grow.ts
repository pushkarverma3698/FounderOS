#!/usr/bin/env -S node --import tsx/esm
/**
 * FounderOS — funding-driven registry grower
 * ==========================================
 * Grow the free-lane board registry by discovering recently funded startups
 * and probing their ATS boards.
 *
 * Flow:
 *   1. Scrape funding news (YourStory, Inc42, Silicon Canals, EU-Startups)
 *   2. Extract company names from headlines
 *   3. Normalise to ATS slug guesses (tokenFor pattern)
 *   4. Probe 6 ATS platforms (Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters, Workable)
 *   5. Verify Greenhouse hits against their declared name
 *   6. Append verified boards to the registry CSV
 *
 * Cost: $0. News sites are public HTML, ATS endpoints are public JSON.
 * No API keys, no LLM, no browser.
 *
 * Usage:
 *   node --import tsx/esm scripts/jobhunt-funding-grow.ts [--dry-run] [--market IN|NL]
 *
 * ENV: Same as jobhunt-board-registry.ts — needs DATABASE_URL etc for
 * config.ts validation but uses none of them.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { boardUrl } from "../src/tools/jobhunt/free-ats-source.js";
import {
  boardsPathFrom,
  parseBoardRegistry,
  registerDiscoveredBoard,
  FREE_ATS_PLATFORMS,
  type FreeAts,
  type FreeBoard,
  type BoardMarket,
} from "../src/tools/jobhunt/free-boards.js";
import { normaliseCompanyName } from "../src/tools/jobhunt/sponsor-match.js";
import { mapWithConcurrencyLimit } from "../src/core/concurrency.js";
import { scrapeAllFundingSources, type FundingSignal } from "../src/tools/jobhunt/funding-scraper.js";

const RUN_DIR = join(process.cwd(), ".funding-grow");
const USER_AGENT = "founderos-funding-grower/1.0 (+jobhunt registry grower)";
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_ATTEMPTS = 3;
const HOST_CONCURRENCY = 3;
const MIN_TOKEN_LENGTH = 4;
const MAX_CONSECUTIVE_UNKNOWN = 10;
const PROGRESS_EVERY = 250;

function log(message: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

type Probe =
  | { readonly kind: "alive" }
  | { readonly kind: "absent"; readonly status: number }
  | { readonly kind: "unknown"; readonly detail: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function probeOnce(url: string): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    void res.body?.cancel();
    if (res.ok) return { kind: "alive" };
    if (res.status === 404 || res.status === 410) return { kind: "absent", status: res.status };
    return { kind: "unknown", detail: `HTTP ${res.status}` };
  } catch (err) {
    return { kind: "unknown", detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url: string): Promise<Probe> {
  let last: Probe = { kind: "unknown", detail: "not attempted" };
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    last = await probeOnce(url);
    if (last.kind !== "unknown") return last;
    if (attempt < PROBE_ATTEMPTS - 1) await sleep(Math.min(1_000 * 2 ** attempt, 30_000));
  }
  return last;
}

function candidateBoard(ats: FreeAts, token: string): FreeBoard {
  return { name: token, ats, token, markets: [] };
}

function tokenFor(name: string): string {
  return normaliseCompanyName(name).replace(/[^a-z0-9]/g, "");
}

async function greenhouseDeclaredName(token: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`,
      { signal: controller.signal, headers: { accept: "application/json", "user-agent": USER_AGENT } },
    );
    if (!res.ok) {
      void res.body?.cancel();
      return null;
    }
    const payload = (await res.json()) as Record<string, unknown>;
    return typeof payload["name"] === "string" ? payload["name"] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Hit {
  readonly ats: FreeAts;
  readonly token: string;
  readonly companyName: string;
  readonly market: string;
}

interface HostResult {
  readonly ats: FreeAts;
  readonly probed: number;
  readonly hits: number;
  readonly unknown: number;
  readonly aborted: boolean;
}

async function sweepHost(
  ats: FreeAts,
  tokens: readonly string[],
  onHit: (ats: FreeAts, token: string) => void,
): Promise<HostResult> {
  let consecutiveUnknown = 0;
  let aborted = false;
  let done = 0;
  let hits = 0;
  let unknown = 0;
  const started = Date.now();

  const results = await mapWithConcurrencyLimit(tokens, HOST_CONCURRENCY, async (token) => {
    if (aborted) return "skipped" as const;

    const result = await probe(boardUrl(candidateBoard(ats, token)));
    done += 1;

    if (result.kind === "unknown") {
      unknown += 1;
      consecutiveUnknown += 1;
      if (consecutiveUnknown >= MAX_CONSECUTIVE_UNKNOWN) {
        aborted = true;
        log(`!! ${ats}: ${MAX_CONSECUTIVE_UNKNOWN} consecutive unknowns (${result.detail}) — abandoning this host.`);
      }
    } else {
      consecutiveUnknown = 0;
      if (result.kind === "alive") {
        hits += 1;
        onHit(ats, token);
      }
    }

    if (done % PROGRESS_EVERY === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      const eta = Math.round((tokens.length - done) / rate / 60);
      log(`   ${ats}: ${done}/${tokens.length} · ${hits} hits · ${unknown} unknown · ${rate.toFixed(1)}/s · ~${eta}m left`);
    }
    return "done" as const;
  });

  return { ats, probed: results.filter((r) => r === "done").length, hits, unknown, aborted };
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsvRow(b: FreeBoard): string {
  return [b.name, b.ats, b.token, b.markets.join("|")].map(csvField).join(",");
}

const CSV_HEADER = "name,ats,board_token,markets";

function writeRegistry(path: string, boards: readonly FreeBoard[]): void {
  writeFileSync(path, `${CSV_HEADER}\n${boards.map(toCsvRow).join("\n")}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const marketArgIndex = args.indexOf("--market");
  const targetMarket = marketArgIndex !== -1 ? args[marketArgIndex + 1] : null;

  mkdirSync(RUN_DIR, { recursive: true });
  const registryPath = boardsPathFrom();
  
  const existing = parseBoardRegistry(readFileSync(registryPath, "utf8"));
  const knownTokens = new Set(existing.map((b) => b.token.toLowerCase()));

  log(`Scraping funding sources...`);
  let signals = await scrapeAllFundingSources();
  if (targetMarket) {
    signals = signals.filter((s) => s.market === targetMarket);
  }

  const candidates = new Map<string, FundingSignal>();
  let tooShort = 0;
  let alreadyKnown = 0;

  for (const sig of signals) {
    const token = tokenFor(sig.company);
    if (token.length < MIN_TOKEN_LENGTH) {
      tooShort += 1;
      continue;
    }
    if (knownTokens.has(token)) {
      alreadyKnown += 1;
      continue;
    }
    if (!candidates.has(token)) candidates.set(token, sig);
  }

  const tokens = [...candidates.keys()].sort();

  log(`Scraped ${signals.length} signals → ${tokens.length} distinct tokens to probe`);
  log(`  (${tooShort} under ${MIN_TOKEN_LENGTH} chars, ${alreadyKnown} already in the registry)`);
  
  if (tokens.length === 0) {
    log("No new tokens to probe. Exiting.");
    return;
  }

  log(`probing ${FREE_ATS_PLATFORMS.length} platforms in parallel, ${HOST_CONCURRENCY} workers each`);

  const found: Hit[] = [];
  const onHit = (ats: FreeAts, token: string): void => {
    const sig = candidates.get(token)!;
    found.push({ ats, token, companyName: sig.company, market: sig.market });
  };

  const started = Date.now();
  const hostResults = await Promise.all(
    FREE_ATS_PLATFORMS.map((ats) => sweepHost(ats, tokens, onHit)),
  );
  log(`discovery finished in ${Math.round((Date.now() - started) / 60_000)} min`);

  const best = new Map<string, Hit>();
  for (const ats of FREE_ATS_PLATFORMS) {
    for (const hit of found) {
      if (hit.ats === ats && !best.has(hit.token)) best.set(hit.token, hit);
    }
  }

  log(`confirming ${[...best.values()].filter((h) => h.ats === "greenhouse").length} greenhouse hit(s)...`);
  const rows: FreeBoard[] = [];
  const unconfirmed: { ats: FreeAts; token: string; companyName: string }[] = [];

  for (const hit of [...best.values()].sort((a, b) => a.token.localeCompare(b.token))) {
    const declared = hit.ats === "greenhouse" ? await greenhouseDeclaredName(hit.token) : null;
    const finalName = declared || hit.companyName;
    
    if (hit.ats === "greenhouse" && !declared) {
      unconfirmed.push({ ats: hit.ats, token: hit.token, companyName: hit.companyName });
      continue;
    }

    const market = hit.market === "NL" || hit.market === "IN" ? hit.market : ("NL" as BoardMarket);
    rows.push({ name: finalName, ats: hit.ats, token: hit.token, markets: [market] });
  }

  if (!dryRun && rows.length > 0) {
    for (const row of rows) {
      await registerDiscoveredBoard(row);
    }
    log(`Wrote ${rows.length} new boards to discovered registry.`);
  } else if (dryRun) {
    log(`Dry run: would have written ${rows.length} boards to discovered registry.`);
  }

  const reportPath = join(RUN_DIR, "report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        dryRun,
        tokensProbed: tokens.length,
        hosts: hostResults,
        discovered: rows.length,
        unconfirmed,
        rows: rows.map((r) => ({ name: r.name, ats: r.ats, token: r.token })),
      },
      null,
      2
    ) + "\n"
  );

  const byAts = (ats: FreeAts): number => rows.filter((r) => r.ats === ats).length;
  console.log(`\n── funding grow ──────────────────────────────────────`);
  console.log(`companies found ${signals.length}`);
  console.log(`tokens probed   ${tokens.length}`);
  console.log(`boards discovered ${rows.length}  (${tokens.length > 0 ? ((rows.length / tokens.length) * 100).toFixed(2) : 0}% hit rate)`);
  console.log(`  greenhouse    ${byAts("greenhouse")}`);
  console.log(`  lever         ${byAts("lever")}`);
  console.log(`  ashby         ${byAts("ashby")}`);
  console.log(`  recruitee     ${byAts("recruitee")}`);
  console.log(`  smartrecruiters ${byAts("smartrecruiters")}`);
  console.log(`  workable      ${byAts("workable")}`);
  if (!dryRun) {
    console.log(`registry        ${existing.length} → ${existing.length + rows.length}`);
  }
  for (const host of hostResults) {
    console.log(`  ${host.ats.padEnd(11)} probed ${host.probed}, unknown ${host.unknown}${host.aborted ? " — ABORTED" : ""}`);
  }
  console.log(`\nunconfirmed greenhouse (dropped): ${unconfirmed.length}`);
  console.log(`report: ${reportPath}`);
}

await main();
