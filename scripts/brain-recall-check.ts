/**
 * Brain recall check (AG-066 Part A). Runs a small golden set of questions through the same search path
 * `search_memory` uses (searchBrain over brain_memories) and fails when the expected doc is not in the top-k,
 * or when a doc the case forbids (a stale, superseded one) is.
 *
 *   pnpm tsx scripts/brain-recall-check.ts [--min N] [--k 3] [--golden path]
 *
 * Exit 1 when hits < --min (default: `baseline` in governance/brain-recall-golden.json) or when a search errors.
 * Runs on the VPS after brain:sync (.github/workflows/brain-sync.yml) because it needs the live store and Ollama.
 */
import { readFileSync } from "node:fs";

export interface RecallCase {
  q: string;
  project: string;
  /** Substring of the expected source path or row content; at least one top-k hit must contain it. */
  expect: string;
  /** Substring of a source that must NOT be in the top-k (a stale doc that used to outrank the current one). */
  forbid?: string;
}

export interface GoldenFile {
  baseline: number;
  cases: RecallCase[];
}

export interface CaseResult {
  case: RecallCase;
  hit: boolean;
  sources: string[];
  reason?: string;
}

export interface RecallOutcome {
  hits: number;
  total: number;
  results: CaseResult[];
}

export type SearchFn = (c: RecallCase) => Promise<{ sources: string[]; contents?: string[] } | { error: string }>;

export function parseCases(raw: unknown): GoldenFile {
  const file = raw as { baseline?: unknown; cases?: unknown };
  if (typeof file?.baseline !== "number" || !Array.isArray(file.cases)) {
    throw new Error("golden file needs a numeric `baseline` and a `cases` array");
  }
  const cases = file.cases.map((c: Record<string, unknown>, i: number) => {
    if (typeof c?.["q"] !== "string" || typeof c["project"] !== "string" || typeof c["expect"] !== "string") {
      throw new Error(`case ${i}: q, project and expect must be strings`);
    }
    if (c["forbid"] !== undefined && typeof c["forbid"] !== "string") throw new Error(`case ${i}: forbid must be a string`);
    return c as unknown as RecallCase;
  });
  return { baseline: file.baseline, cases };
}

/** Pure: does the top-k source list satisfy the case? */
export function evaluateRecall(c: RecallCase, sources: string[], k = 3, contents: string[] = []): CaseResult {
  const top = sources.slice(0, k);
  const forbidden = c.forbid ? top.find((s) => s.includes(c.forbid as string)) : undefined;
  if (forbidden) return { case: c, hit: false, sources: top, reason: `forbidden source in top ${k}: ${forbidden}` };
  // Agent-written rows carry source "ide_mcp", so the current rule is often only recognisable by its content.
  const matches = (s: string, i: number) => s.includes(c.expect) || (contents[i] ?? "").includes(c.expect);
  if (!top.some(matches)) {
    return { case: c, hit: false, sources: top, reason: `expected "${c.expect}" not in top ${k}` };
  }
  return { case: c, hit: true, sources: top };
}

export async function runRecall(cases: RecallCase[], search: SearchFn, k = 3): Promise<RecallOutcome> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const found = await search(c);
    results.push("error" in found ? { case: c, hit: false, sources: [], reason: `search error: ${found.error}` } : evaluateRecall(c, found.sources, k, found.contents));
  }
  return { hits: results.filter((r) => r.hit).length, total: results.length, results };
}

export function formatReport(out: RecallOutcome, k = 3): string {
  const lines = out.results
    .filter((r) => !r.hit)
    .map((r) => `MISS  "${r.case.q}" (${r.case.project}): ${r.reason}\n      got: ${r.sources.length ? r.sources.join(" | ") : "(nothing)"}`);
  lines.push(`recall@${k} = ${out.hits}/${out.total}`);
  return lines.join("\n");
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const golden = parseCases(JSON.parse(readFileSync(argValue(args, "--golden") ?? "governance/brain-recall-golden.json", "utf8")));
  const k = Number(argValue(args, "--k") ?? 3);
  const min = Number(argValue(args, "--min") ?? golden.baseline);

  // Imported here so the pure functions above load without a database client (unit tests).
  const { searchBrain } = await import("../src/db/rag-search.js");
  const search: SearchFn = async (c) => {
    const res = await searchBrain({ query: c.q, topK: k, filters: { project: c.project }, table: "brain_memories" });
    if ("error" in res) return { error: `${res.error.stage}: ${res.error.message}` };
    return { sources: res.hits.map((h) => h.source ?? ""), contents: res.hits.map((h) => h.content) };
  };

  const out = await runRecall(golden.cases, search, k);
  console.log(formatReport(out, k));
  if (out.results.some((r) => r.reason?.startsWith("search error"))) process.exit(1);
  if (out.hits < min) {
    console.log(`FAIL: recall ${out.hits} is below the minimum ${min}`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1]?.endsWith("brain-recall-check.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
