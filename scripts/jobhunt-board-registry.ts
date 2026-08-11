#!/usr/bin/env -S node --import tsx/esm
/**
 * FounderOS — free-ATS board registry maintenance (one-off)
 * =========================================================
 * Two jobs against `docs/strategy/data/free-ats-boards.csv`, the list the free
 * lane polls every thirty minutes.
 *
 *   prune  — poll every board once; drop the tokens that are definitively gone.
 *   grow   — guess board tokens for the IND recognised-sponsor register and keep
 *            the ones that answer.
 *
 * WHY PRUNE. A rotated Greenhouse token 404s forever. It costs a request every
 * half hour and, worse, it lands in `sweepBoards`' failure count — the number
 * that is supposed to mean "the lane is broken" rather than "the market is
 * quiet". A permanent floor of dead tokens is exactly the noise that hides a
 * real outage behind a number nobody reads any more.
 *
 * WHY GROW. The registry was ported from a gaming-dominated dataset and only 24
 * of its 238 boards were sourced for the Dutch market. The IND register is the
 * population that can lawfully make a highly-skilled-migrant hire, which is the
 * only NL population this pipeline can act on.
 *
 * THE ONE RULE BOTH JOBS SHARE: only a definitive 404/410 is evidence of
 * absence. A timeout, a 429, a 5xx or a transport error is `unknown` — never
 * "dead", never "no board". Reading a rate-limited host as absence is how a
 * maintenance script silently deletes a working registry, or concludes that
 * twelve thousand employers have no job board because one host got tired of us.
 * Every count below reports `unknown` separately, and `unknown` never acts.
 *
 * Cost: $0. These are the same unauthenticated public endpoints the lane already
 * polls. No API keys, no LLM calls.
 *
 * Usage (from the repo root):
 *   node --import tsx/esm scripts/jobhunt-board-registry.ts prune
 *   node --import tsx/esm scripts/jobhunt-board-registry.ts grow [--resume]
 *
 * `grow` takes ~100 minutes. It checkpoints, so --resume picks up where a killed
 * run stopped instead of re-probing from zero.
 *
 * ENV. This script needs no credentials — it reads two CSVs and polls public
 * endpoints. But `boardUrl()` lives beside the lane's logger, which pulls in
 * `src/core/config.ts`, which validates the whole app env at import time. In a
 * worktree with no `.env`, satisfy the validator with placeholders rather than
 * copying real secrets in:
 *
 *   DATABASE_URL=postgresql://x:x@localhost:5432/x TELEGRAM_BOT_TOKEN=0:x \
 *   TELEGRAM_CHAT_ID=0 node --import tsx/esm scripts/jobhunt-board-registry.ts prune
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { boardUrl, BOARD_CONCURRENCY } from "../src/tools/jobhunt/free-ats-source.js";
import {
  boardsPathFrom,
  parseBoardRegistry,
  FREE_ATS_PLATFORMS,
  type FreeAts,
  type FreeBoard,
} from "../src/tools/jobhunt/free-boards.js";
import {
  REPO_ROOT,
  parseSponsorCsv,
  registerPathFrom,
} from "../src/tools/jobhunt/sponsor-registry.js";
import { normaliseCompanyName } from "../src/tools/jobhunt/sponsor-match.js";
import { mapWithConcurrencyLimit } from "../src/core/concurrency.js";

const RUN_DIR = join(REPO_ROOT, ".board-registry");

/** Identify ourselves. A host that wants to throttle us should be able to. */
const USER_AGENT = "founderos-board-registry/1.0 (+jobhunt free lane maintenance)";

const PROBE_TIMEOUT_MS = 10_000;

/** Attempts per probe before an `unknown` is accepted as `unknown`. */
const PROBE_ATTEMPTS = 3;

/** Rounds a board must fail before the prune believes it. */
const RECONFIRM_ROUNDS = 3;
const RECONFIRM_DELAY_MS = 30_000;

/**
 * Workers per host during discovery.
 *
 * Measured, not guessed: 240 probes at this rate returned zero non-404s and
 * finished in 36s (2026-08-06). The three platforms are three separate origins,
 * so they run concurrently — that is 3x the wall-clock speed at no cost to any
 * single host's politeness.
 */
const HOST_CONCURRENCY = 3;

/**
 * Shortest token worth probing.
 *
 * A guessed token that answers 200 is not proof the board belongs to the company
 * we guessed it from, and short tokens are where that goes wrong: "ing", "abn"
 * and "nn" are real Dutch employers and also real substrings of somebody else's
 * board. Four characters is the floor at which a collision stops being likely;
 * it keeps every hit found during sampling (`akqa`, `adyen`, `dataiku`).
 */
const MIN_TOKEN_LENGTH = 4;

/**
 * Consecutive unknowns before a host is abandoned.
 *
 * Each probe already retries three times with backoff, so ten consecutive
 * unknowns is ~30 failed requests in a row — a wholesale block, not a blip. The
 * alternative to abandoning is worse than stopping: a throttled host answers
 * every remaining token with an error, and if those were read as absence the run
 * would confidently report that twelve thousand companies have no board.
 */
const MAX_CONSECUTIVE_UNKNOWN = 10;

const PROGRESS_EVERY = 250;

type Probe =
  | { readonly kind: "alive" }
  | { readonly kind: "absent"; readonly status: number }
  | { readonly kind: "unknown"; readonly detail: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function log(message: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

/** One request. Status only — the body is never read, so it is always cancelled. */
async function probeOnce(url: string): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    // Discard the body explicitly: an unconsumed body holds the socket open
    // under undici until GC, and this script opens tens of thousands of them.
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

/** Retry only `unknown`. A 404 is an answer, not a failure to get one. */
async function probe(url: string): Promise<Probe> {
  let last: Probe = { kind: "unknown", detail: "not attempted" };
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    last = await probeOnce(url);
    if (last.kind !== "unknown") return last;
    if (attempt < PROBE_ATTEMPTS - 1) await sleep(Math.min(1_000 * 2 ** attempt, 30_000));
  }
  return last;
}

/** A token to probe, shaped as the `FreeBoard` that `boardUrl()` expects. */
function candidateBoard(ats: FreeAts, token: string): FreeBoard {
  return { name: token, ats, token, markets: [] };
}

const boardKey = (b: FreeBoard): string => `${b.ats}:${b.token}`;
const describe = (p: Probe): string =>
  p.kind === "absent" ? `HTTP ${p.status}` : p.kind === "unknown" ? p.detail : "200";

// ─── CSV writing ────────────────────────────────────────────────────────────

/** Quote only when the field would otherwise change meaning. */
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

function writeReport(name: string, body: unknown): string {
  mkdirSync(RUN_DIR, { recursive: true });
  const path = join(RUN_DIR, name);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

// ─── prune ──────────────────────────────────────────────────────────────────

async function prune(): Promise<void> {
  const path = boardsPathFrom();
  const raw = readFileSync(path, "utf8");
  const boards = parseBoardRegistry(raw);

  // A row the parser skipped never reaches the sweep, but rewriting the file
  // from parsed output would delete it silently. Say so instead.
  const dataLines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1;
  if (dataLines !== boards.length) {
    log(`NOTE: ${dataLines} data lines parsed to ${boards.length} boards (dupes/malformed dropped).`);
  }

  log(`Polling ${boards.length} boards at concurrency ${BOARD_CONCURRENCY}…`);

  const outcomes = new Map<string, Probe[]>();
  let pending: readonly FreeBoard[] = boards;

  for (let round = 1; round <= RECONFIRM_ROUNDS && pending.length > 0; round++) {
    if (round > 1) {
      log(`${pending.length} board(s) did not answer — re-probe ${round}/${RECONFIRM_ROUNDS} in ${RECONFIRM_DELAY_MS / 1000}s…`);
      await sleep(RECONFIRM_DELAY_MS);
    }
    const results = await mapWithConcurrencyLimit(pending, BOARD_CONCURRENCY, (b) =>
      probe(boardUrl(b)),
    );
    const next: FreeBoard[] = [];
    pending.forEach((b, i) => {
      const result = results[i]!;
      outcomes.set(boardKey(b), [...(outcomes.get(boardKey(b)) ?? []), result]);
      if (result.kind !== "alive") next.push(b);
    });
    log(`  round ${round}: ${pending.length - next.length} alive, ${next.length} still not answering`);
    pending = next;
  }

  // Dead only if it failed EVERY round and every one of those was a definitive
  // absence. One `unknown` anywhere in the history and the board is kept.
  const deadKeys = new Set<string>();
  const unknownKeys = new Set<string>();
  for (const b of boards) {
    const history = outcomes.get(boardKey(b)) ?? [];
    if (history.length < RECONFIRM_ROUNDS || history.some((r) => r.kind === "alive")) continue;
    if (history.every((r) => r.kind === "absent")) deadKeys.add(boardKey(b));
    else unknownKeys.add(boardKey(b));
  }

  const survivors = boards.filter((b) => !deadKeys.has(boardKey(b)));
  writeRegistry(path, survivors);

  const detail = boards.map((b) => ({
    name: b.name,
    ats: b.ats,
    token: b.token,
    verdict: deadKeys.has(boardKey(b)) ? "dead" : unknownKeys.has(boardKey(b)) ? "unknown" : "alive",
    attempts: (outcomes.get(boardKey(b)) ?? []).map(describe),
  }));
  const reportPath = writeReport("prune-report.json", {
    ranAt: new Date().toISOString(),
    before: boards.length,
    dead: deadKeys.size,
    unknownKept: unknownKeys.size,
    after: survivors.length,
    boards: detail,
  });

  console.log(`\n── prune ─────────────────────────────────────`);
  console.log(`before          ${boards.length}`);
  console.log(`dead (removed)  ${deadKeys.size}`);
  console.log(`unknown (kept)  ${unknownKeys.size}`);
  console.log(`after           ${survivors.length}`);
  for (const row of detail.filter((d) => d.verdict !== "alive")) {
    console.log(`  ${row.verdict.padEnd(8)} ${row.ats}/${row.token} — ${row.attempts.join(", ")}`);
  }
  console.log(`\nreport: ${reportPath}\nregistry: ${path}`);
}

// ─── grow ───────────────────────────────────────────────────────────────────

interface Hit {
  readonly ats: FreeAts;
  readonly token: string;
  readonly registerName: string;
}

/**
 * The token guess, ported from `guess_ats_token` (funding_tracker.py:76-101)
 * with ONE substitution.
 *
 * The original normalises with `re.sub(r'[^a-zA-Z0-9]','',name.lower())`, which
 * keeps the legal suffix: "Adyen N.V." becomes `adyennv`, which 404s, while
 * `adyen` returns 200. 87% of the 12,883 register names carry such a suffix, so
 * the verbatim normaliser would miss most of the register by construction.
 * `normaliseCompanyName` already strips exactly those trailing tokens (and
 * deliberately keeps "holding"/"group", which are genuinely different entities)
 * — so the probe half is ported as-is and the normalisation half defers to the
 * function this repo already trusts for the same job.
 */
function tokenFor(name: string): string {
  return normaliseCompanyName(name).replace(/[^a-z0-9]/g, "");
}

/**
 * Greenhouse alone will say who it thinks it is (`/v1/boards/{token}` → `name`).
 * Used so a discovered row states a fetched fact rather than the assumption that
 * a guessed token belongs to the company we guessed it from.
 */
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
  from: number,
  onHit: (ats: FreeAts, token: string) => void,
): Promise<HostResult> {
  const slice = tokens.slice(from);
  let consecutiveUnknown = 0;
  let aborted = false;
  let done = 0;
  let hits = 0;
  let unknown = 0;
  const started = Date.now();

  const results = await mapWithConcurrencyLimit(slice, HOST_CONCURRENCY, async (token) => {
    if (aborted) return "skipped" as const;

    const result = await probe(boardUrl(candidateBoard(ats, token)));
    done += 1;

    if (result.kind === "unknown") {
      unknown += 1;
      consecutiveUnknown += 1;
      if (consecutiveUnknown >= MAX_CONSECUTIVE_UNKNOWN) {
        aborted = true;
        log(`!! ${ats}: ${MAX_CONSECUTIVE_UNKNOWN} consecutive unknowns (${result.detail}) — abandoning this host rather than recording absence.`);
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
      const eta = Math.round((slice.length - done) / rate / 60);
      log(`   ${ats}: ${done}/${slice.length} · ${hits} hits · ${unknown} unknown · ${rate.toFixed(1)}/s · ~${eta}m left`);
      writeFileSync(join(RUN_DIR, `progress-${ats}.json`), JSON.stringify({ completed: from + done }));
    }
    return "done" as const;
  });

  return { ats, probed: results.filter((r) => r === "done").length, hits, unknown, aborted };
}

async function grow(resume: boolean): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true });
  const hitsPath = join(RUN_DIR, "hits.jsonl");
  const registryPath = boardsPathFrom();

  const existing = parseBoardRegistry(readFileSync(registryPath, "utf8"));
  const known = new Set(existing.map((b) => b.token.toLowerCase()));

  const registerNames = parseSponsorCsv(readFileSync(registerPathFrom(), "utf8"));

  // token → the register name it came from. Sorted, so a resumed run walks the
  // same order and a checkpoint index still means what it meant.
  const candidates = new Map<string, string>();
  let tooShort = 0;
  let alreadyKnown = 0;
  for (const name of registerNames) {
    const token = tokenFor(name);
    if (token.length < MIN_TOKEN_LENGTH) {
      tooShort += 1;
      continue;
    }
    if (known.has(token)) {
      alreadyKnown += 1;
      continue;
    }
    if (!candidates.has(token)) candidates.set(token, name);
  }
  const tokens = [...candidates.keys()].sort();

  log(`register: ${registerNames.length} names → ${tokens.length} distinct tokens to probe`);
  log(`  (${tooShort} under ${MIN_TOKEN_LENGTH} chars, ${alreadyKnown} already in the registry)`);
  log(`probing ${FREE_ATS_PLATFORMS.length} platforms in parallel, ${HOST_CONCURRENCY} workers each`);

  const found: Hit[] = [];
  const onHit = (ats: FreeAts, token: string): void => {
    const hit: Hit = { ats, token, registerName: candidates.get(token) ?? token };
    found.push(hit);
    appendFileSync(hitsPath, `${JSON.stringify(hit)}\n`);
  };

  // Resume reads the per-host checkpoint and rewinds by the pool depth: `done`
  // counts completions, and with N workers in flight the last N may not have
  // been contiguous. Re-probing a few tokens is free; skipping one is not.
  const startAt = (ats: FreeAts): number => {
    const file = join(RUN_DIR, `progress-${ats}.json`);
    if (!resume || !existsSync(file)) return 0;
    const { completed } = JSON.parse(readFileSync(file, "utf8")) as { completed: number };
    return Math.max(0, completed - HOST_CONCURRENCY);
  };

  if (resume && existsSync(hitsPath)) {
    for (const line of readFileSync(hitsPath, "utf8").split("\n").filter(Boolean)) {
      found.push(JSON.parse(line) as Hit);
    }
    log(`resuming with ${found.length} hit(s) already recorded`);
  }

  const started = Date.now();
  const hostResults = await Promise.all(
    FREE_ATS_PLATFORMS.map((ats) => sweepHost(ats, tokens, startAt(ats), onHit)),
  );
  log(`discovery finished in ${Math.round((Date.now() - started) / 60_000)} min`);

  // One board per company. Precedence follows FREE_ATS_PLATFORMS, which is the
  // Python's order: greenhouse, then lever, then ashby.
  const best = new Map<string, Hit>();
  for (const ats of FREE_ATS_PLATFORMS) {
    for (const hit of found) {
      if (hit.ats === ats && !best.has(hit.token)) best.set(hit.token, hit);
    }
  }

  log(`confirming ${[...best.values()].filter((h) => h.ats === "greenhouse").length} greenhouse hit(s) against their declared name…`);
  const rows: FreeBoard[] = [];
  const mismatches: { token: string; declared: string; register: string }[] = [];
  const unconfirmed: { ats: FreeAts; token: string; register: string }[] = [];

  for (const hit of [...best.values()].sort((a, b) => a.token.localeCompare(b.token))) {
    // A row is written ONLY when the board itself declares who it belongs to.
    //
    // The registry's `name` column is not a label — it is the employer identity
    // every posting from that board inherits (`free-ats-mappers.ts`:
    // `company: candidate.board.name`), and that identity is what the sponsor
    // gate matches against the IND register. Writing the REGISTER's name onto a
    // board whose owner we could not confirm asserts the one fact the gate
    // exists to establish, from a token guess.
    //
    // Measured 2026-08-06: the first run wrote 61 such rows, and
    // matchSponsor() returned a confident `sponsor` PASS for every one of them
    // — "Focus B.V.", "Lemonade B.V.", "SoSafe B.V." — when the boards behind
    // those tokens are far more likely the US/German/Belgian companies of the
    // same name. A false PASS on the permit gate costs an application AND
    // teaches the founder to trust a gate that guessed.
    //
    // A confirmed name that DISAGREES with the register is kept, because it is
    // still the truth about who owns the board: matchSponsor then honestly
    // returns `uncertain` or `not-sponsor` ("General Assembly Remote Jobs" →
    // uncertain, "Wellhub" → not-sponsor), and an honest miss is supply the
    // founder can judge. Only the unverifiable ones are dropped.
    const declared = hit.ats === "greenhouse" ? await greenhouseDeclaredName(hit.token) : null;
    if (declared === null) {
      unconfirmed.push({ ats: hit.ats, token: hit.token, register: hit.registerName });
      continue;
    }
    if (normaliseCompanyName(declared) !== normaliseCompanyName(hit.registerName)) {
      mismatches.push({ token: hit.token, declared, register: hit.registerName });
    }
    rows.push({ name: declared, ats: hit.ats, token: hit.token, markets: ["NL"] });
  }

  writeRegistry(registryPath, [...existing, ...rows]);

  const reportPath = writeReport("grow-report.json", {
    ranAt: new Date().toISOString(),
    tokensProbed: tokens.length,
    hosts: hostResults,
    discovered: rows.length,
    hitRatePct: Number(((rows.length / tokens.length) * 100).toFixed(2)),
    mismatches,
    unconfirmed,
    rows: rows.map((r) => ({ name: r.name, ats: r.ats, token: r.token })),
  });

  const byAts = (ats: FreeAts): number => rows.filter((r) => r.ats === ats).length;
  console.log(`\n── grow ──────────────────────────────────────`);
  console.log(`tokens probed   ${tokens.length}`);
  console.log(`discovered      ${rows.length}  (${((rows.length / tokens.length) * 100).toFixed(2)}% hit rate)`);
  console.log(`  greenhouse    ${byAts("greenhouse")}`);
  console.log(`  lever         ${byAts("lever")}`);
  console.log(`  ashby         ${byAts("ashby")}`);
  console.log(`registry        ${existing.length} → ${existing.length + rows.length}`);
  for (const host of hostResults) {
    console.log(`  ${host.ats.padEnd(11)} probed ${host.probed}, unknown ${host.unknown}${host.aborted ? " — ABORTED" : ""}`);
  }
  if (mismatches.length > 0) {
    console.log(`\nname mismatches (kept, board's own name used — eyeball these):`);
    for (const m of mismatches) console.log(`  ${m.token}: board says "${m.declared}", register says "${m.register}"`);
  }
  console.log(`\nunconfirmed (no name in payload): ${unconfirmed.length}`);
  console.log(`report: ${reportPath}\nregistry: ${registryPath}`);
}

// ─── entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const resume = process.argv.includes("--resume");

  if (command === "prune") await prune();
  else if (command === "grow") await grow(resume);
  else {
    console.error(
      "usage:\n" +
        "  node --import tsx/esm scripts/jobhunt-board-registry.ts prune\n" +
        "  node --import tsx/esm scripts/jobhunt-board-registry.ts grow [--resume]",
    );
    process.exit(1);
  }
}

await main();
