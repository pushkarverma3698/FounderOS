/**
 * FounderOS — Architectural fitness functions (v3 anti-slop invariants)
 * ======================================================================
 * CI gate that makes architectural decay a BUILD FAILURE instead of a code-review
 * opinion. Ratchet design: pre-existing violations are pinned in
 * governance/architecture-baseline.json and may only DECREASE. Any new violation
 * fails immediately; when a phase deletes debt, run with --update-baseline to
 * lower the pin (raising it by hand is the one thing reviewers must reject).
 *
 * Rules (see JARVIS-ARCHITECTURE.md + the approved v3 plan):
 *   R1 gateway-imports   nothing outside src/gateway + src/index.ts imports gateway
 *   R2 kernel-purity     src/kernel imports only kernel/core/db/infra/tools
 *   R3 fail-open-catch   `.catch(() =>` swallows require an `allow-failopen:` tag
 *   R4 loc-budget        no src file over 400 lines
 *   R5 regex-routing     exported *_RE control-flow regexes outside the kernel
 *   R6 tombstones        deleted slop modules must STAY deleted (hard fail)
 *
 * Usage:
 *   node --import tsx/esm scripts/verify-architecture.ts            # verify
 *   node --import tsx/esm scripts/verify-architecture.ts --update-baseline
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const BASELINE_PATH = join(ROOT, "governance", "architecture-baseline.json");

/** Modules deleted by the v3 kill order. Re-creating one fails CI hard (no ratchet). */
export const TOMBSTONES: string[] = [
  // The three-layer control split (audit §6) — never again:
  "src/gateway/office-run.ts",
  "src/gateway/execution-guard.ts",
  "src/gateway/pre-router.ts",
  "src/gateway/task-ledger.ts",
  // Regex fast-path bypasses of the graph:
  "src/gateway/inbox-fast-path.ts",
  "src/gateway/github-read-fast-path.ts",
  "src/gateway/shell-hitl-fast-path.ts",
  // The LLM supervisor + flag-gated alternate topologies:
  "src/agents/office.ts",
  "src/agents/engineering-domain.ts",
  "src/agents/revenue-domain.ts",
  "src/agents/creative-department.ts",
  // Typed-object-smuggled-through-prose handoff:
  "src/agents/handoff-engineering.ts",
];

/** Frozen trees (founder decision 2026-07-07): excluded from every rule. */
const FROZEN = ["apps/", "client/", "Github/"];

export interface Violation {
  rule: string;
  file: string;
  detail: string;
}

export interface RuleResult {
  rule: string;
  violations: Violation[];
}

// ── File walking ──────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function srcFiles(): Array<{ rel: string; text: string }> {
  return walk(join(ROOT, "src"))
    .map((f) => relative(ROOT, f))
    .filter((rel) => !FROZEN.some((p) => rel.startsWith(p)))
    .map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), "utf8") }));
}

// ── Rules (pure — take file list, return violations) ──────────────────────────

const IMPORT_RE = /^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm;

export function importsOf(text: string): string[] {
  const specs: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) specs.push(m[1]!);
  return specs;
}

/** Resolve a relative import specifier to a repo-relative path prefix (no ext). */
export function resolveImport(fromRel: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // package import
  const dir = fromRel.split("/").slice(0, -1);
  const parts = spec.replace(/\.js$/, "").split("/");
  const stack = [...dir];
  for (const p of parts) {
    if (p === ".") continue;
    else if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack.join("/");
}

export function ruleGatewayImports(files: Array<{ rel: string; text: string }>): RuleResult {
  const violations: Violation[] = [];
  for (const { rel, text } of files) {
    if (rel.startsWith("src/gateway/") || rel === "src/index.ts") continue;
    for (const spec of importsOf(text)) {
      const resolved = resolveImport(rel, spec);
      if (resolved?.startsWith("src/gateway/")) {
        violations.push({ rule: "gateway-imports", file: rel, detail: `imports ${resolved}` });
      }
    }
  }
  return { rule: "gateway-imports", violations };
}

const KERNEL_ALLOWED = ["src/kernel/", "src/core/", "src/db/", "src/infra/", "src/tools/"];

export function ruleKernelPurity(files: Array<{ rel: string; text: string }>): RuleResult {
  const violations: Violation[] = [];
  for (const { rel, text } of files) {
    if (!rel.startsWith("src/kernel/")) continue;
    for (const spec of importsOf(text)) {
      const resolved = resolveImport(rel, spec);
      if (resolved && resolved.startsWith("src/") && !KERNEL_ALLOWED.some((p) => resolved.startsWith(p))) {
        violations.push({ rule: "kernel-purity", file: rel, detail: `imports ${resolved}` });
      }
    }
  }
  return { rule: "kernel-purity", violations };
}

/** `.catch(() =>` — the swallow signature. Tag the line (or the one above) with `allow-failopen: <reason>`. */
export function ruleFailOpenCatch(files: Array<{ rel: string; text: string }>): RuleResult {
  const violations: Violation[] = [];
  for (const { rel, text } of files) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/\.catch\(\s*\(\s*\)\s*=>/.test(line) || /\.catch\(\s*\(\w+\)\s*=>\s*(null|undefined|false|0|\[\]|\{\})\s*\)/.test(line)) {
        const tagged = line.includes("allow-failopen:") || (i > 0 && lines[i - 1]!.includes("allow-failopen:"));
        if (!tagged) {
          violations.push({ rule: "fail-open-catch", file: rel, detail: `line ${i + 1}: ${line.trim().slice(0, 80)}` });
        }
      }
    });
  }
  return { rule: "fail-open-catch", violations };
}

export const LOC_BUDGET = 400;

export function ruleLocBudget(files: Array<{ rel: string; text: string }>): RuleResult {
  const violations: Violation[] = [];
  for (const { rel, text } of files) {
    const loc = text.split("\n").length;
    if (loc > LOC_BUDGET) {
      violations.push({ rule: "loc-budget", file: rel, detail: `${loc} lines (budget ${LOC_BUDGET})` });
    }
  }
  return { rule: "loc-budget", violations };
}

/** Exported SCREAMING_CASE *_RE regex consts outside src/kernel — routing/claim regexes are kernel-only (and even there, discouraged). */
export function ruleRegexRouting(files: Array<{ rel: string; text: string }>): RuleResult {
  const violations: Violation[] = [];
  for (const { rel, text } of files) {
    if (rel.startsWith("src/kernel/")) continue;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/^export const [A-Z0-9_]*_RE\b/.test(line)) {
        violations.push({ rule: "regex-routing", file: rel, detail: `line ${i + 1}: ${line.trim().slice(0, 80)}` });
      }
    });
  }
  return { rule: "regex-routing", violations };
}

export function ruleTombstones(root: string = ROOT): RuleResult {
  const violations: Violation[] = TOMBSTONES.filter((p) => existsSync(join(root, p))).map((p) => ({
    rule: "tombstones",
    file: p,
    detail: "deleted module has been re-created — the kill order is permanent",
  }));
  return { rule: "tombstones", violations };
}

// ── Ratchet ───────────────────────────────────────────────────────────────────

type Baseline = Record<string, number>;

export function checkRatchet(results: RuleResult[], baseline: Baseline): { ok: boolean; report: string[] } {
  const report: string[] = [];
  let ok = true;
  for (const r of results) {
    const pinned = baseline[r.rule] ?? 0;
    const n = r.violations.length;
    if (n > pinned) {
      ok = false;
      report.push(`✗ ${r.rule}: ${n} violations (baseline ${pinned}) — NEW DEBT, fix it or it doesn't merge:`);
      for (const v of r.violations.slice(0, 25)) report.push(`    ${v.file} — ${v.detail}`);
    } else if (n < pinned) {
      report.push(`✓ ${r.rule}: ${n} (baseline ${pinned}) — debt reduced; run --update-baseline to pin the win`);
    } else {
      report.push(`✓ ${r.rule}: ${n} (= baseline)`);
    }
  }
  return { ok, report };
}

export function ruleOrphanSubsystem(files: Array<{ rel: string; text: string }>): RuleResult {
  const violations: Violation[] = [];
  const srcDirs = readdirSync(join(ROOT, "src")).filter((f) => {
    const st = statSync(join(ROOT, "src", f));
    return st.isDirectory() && !f.startsWith(".");
  });

  for (const dir of srcDirs) {
    const prefix = `src/${dir}/`;
    let isImported = false;
    for (const { rel, text } of files) {
      if (rel.startsWith(prefix)) continue; // ignore internal references
      for (const spec of importsOf(text)) {
        const resolved = resolveImport(rel, spec);
        if (resolved?.startsWith(prefix) || resolved === `src/${dir}`) {
          isImported = true;
          break;
        }
      }
      if (isImported) break;
    }
    if (!isImported) {
      violations.push({
        rule: "orphan-subsystem",
        file: prefix,
        detail: `directory has zero external importers in src/`,
      });
    }
  }
  return { rule: "orphan-subsystem", violations };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function runAllRules(): RuleResult[] {
  const files = srcFiles();
  return [
    ruleGatewayImports(files),
    ruleKernelPurity(files),
    ruleFailOpenCatch(files),
    ruleLocBudget(files),
    ruleRegexRouting(files),
    ruleOrphanSubsystem(files),
  ];
}

const isMain = process.argv[1]?.endsWith("verify-architecture.ts");
if (isMain) {
  const results = runAllRules();
  const tomb = ruleTombstones();

  if (process.argv.includes("--update-baseline")) {
    const baseline: Baseline = Object.fromEntries(results.map((r) => [r.rule, r.violations.length]));
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`Baseline written to ${relative(ROOT, BASELINE_PATH)}:`, baseline);
    process.exit(0);
  }

  const baseline: Baseline = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline)
    : {};
  const { ok, report } = checkRatchet(results, baseline);
  for (const line of report) console.log(line);

  if (tomb.violations.length > 0) {
    for (const v of tomb.violations) console.error(`✗ TOMBSTONE: ${v.file} — ${v.detail}`);
    process.exit(1);
  }
  if (!ok) process.exit(1);
  console.log("Architecture gates green.");
}
