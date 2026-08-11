/**
 * M0a — Evolution Engine v0: dead-code analyzers.
 * ================================================
 * Three pure analyzers over already-read source text. Together they must
 * re-derive the findings of the 2026-08-06 hand audit — that is the M0a
 * acceptance gate (docs/founderos-v2/05-RISKS-AND-GATES.md §2). If the sensor
 * cannot reproduce a known-true finding, every engine downstream of it inherits
 * a wrong measurement.
 *
 * Each analyzer encodes a false-positive trap that produced a WRONG answer
 * during that audit (see docs/founderos-v2/04-DESIGN-LOG.md):
 *   - dead exports: counting references OUTSIDE the declaring file wrongly
 *     flagged `buildLessonStore`, which is wired in kernel-boot.ts;
 *   - orphan modules: naive path matching wrongly flagged 17 `src/tools/*`
 *     files that are imported via deep relative paths;
 *   - unused deps: prefix matching would count `@langchain/langgraph-checkpoint`
 *     as use of `@langchain/langgraph`.
 */

import type { Finding, SourceFile } from "../types.js";

export type { Finding, SourceFile } from "../types.js";

/** A declaration contributes one occurrence; anything more means it is referenced. */
const UNREFERENCED_OCCURRENCE_COUNT = 1;

/** Module basenames that are reachable by definition — nothing imports an entry point. */
const ENTRY_POINT_BASENAMES: ReadonlySet<string> = new Set(["index", "main"]);

const EXPORT_DECL_RE = /^export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Frequency of every identifier across the WHOLE corpus, declarations included.
 * Built once so each symbol lookup is O(1) rather than a re-scan per symbol.
 */
function identifierFrequency(files: readonly SourceFile[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const { text } of files) {
    for (const [token] of text.matchAll(IDENTIFIER_RE)) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }
  return freq;
}

function exportedSymbols(file: SourceFile): string[] {
  return [...file.text.matchAll(EXPORT_DECL_RE)].map((m) => m[1]!);
}

/**
 * Exported symbols that occur exactly once in the corpus — the single
 * occurrence being their own declaration.
 *
 * Counting across the whole corpus (not "outside the declaring file") is the
 * correction that matters: a helper used only by its own module is wired, not dead.
 */
export function findDeadExports(files: readonly SourceFile[]): Finding[] {
  const freq = identifierFrequency(files);
  const findings: Finding[] = [];

  for (const file of files) {
    for (const symbol of exportedSymbols(file)) {
      if ((freq.get(symbol) ?? 0) > UNREFERENCED_OCCURRENCE_COUNT) continue;
      findings.push({
        kind: "dead-export",
        subject: symbol,
        evidence:
          `"${symbol}" is exported from ${file.path} but its name appears exactly once ` +
          `in the whole source tree — that one occurrence is its own declaration, so nothing uses it.`,
        severity: "low",
        location: file.path,
      });
    }
  }
  return findings;
}

function basenameOf(path: string): string {
  return path.split("/").pop()!.replace(/\.tsx?$/, "");
}

/** Drop the extension so a module path and a resolved import specifier compare equal. */
function moduleIdOf(path: string): string {
  return path.replace(/\.tsx?$/, "");
}

const IMPORT_SPEC_RE = /^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm;

/**
 * Resolve a relative specifier to a repo-relative module id (no extension).
 * Mirrors `resolveImport` in scripts/verify-architecture.ts — the same proven
 * logic the architecture gate already trusts. Package imports return null.
 */
export function resolveImport(fromPath: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const stack = fromPath.split("/").slice(0, -1);
  for (const part of spec.replace(/\.js$/, "").split("/")) {
    if (part === ".") continue;
    else if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

/**
 * Every module id each file imports.
 *
 * Reachability is computed from IMPORT SPECIFIERS, never from raw file text.
 * Scanning raw text means a comment that merely mentions `src/outreach/graph.ts`
 * marks the whole dead subsystem as alive — which is exactly what happened when
 * this analyzer's own doc comment cited the example it was written to detect.
 */
function importedModuleIds(files: readonly SourceFile[]): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const file of files) {
    const ids = new Set<string>();
    for (const [, spec] of file.text.matchAll(IMPORT_SPEC_RE)) {
      const resolved = resolveImport(file.path, spec!);
      if (resolved) ids.add(resolved);
    }
    byFile.set(file.path, ids);
  }
  return byFile;
}

/**
 * Modules no other file imports, by resolved import specifier — so a module is
 * reachable only if some other file genuinely imports it, at any relative depth.
 */
export function findOrphanModules(files: readonly SourceFile[]): Finding[] {
  const imports = importedModuleIds(files);

  return files.flatMap((file) => {
    if (ENTRY_POINT_BASENAMES.has(basenameOf(file.path))) return [];

    const id = moduleIdOf(file.path);
    const isImported = files.some((o) => o.path !== file.path && imports.get(o.path)!.has(id));
    if (isImported) return [];

    return [
      {
        kind: "orphan-module",
        subject: file.path,
        evidence:
          `No file in the source tree imports ${file.path}. The module is compiled and shipped ` +
          `but cannot be reached from any entry point.`,
        severity: "medium",
        location: file.path,
      } satisfies Finding,
    ];
  });
}

/**
 * Whole subsystems reachable only from inside themselves.
 *
 * Module-level orphan detection cannot see these: `src/outreach/graph.ts`
 * imports `src/outreach/nodes.ts`, so every file looks imported while the
 * directory as a whole is unreachable from the application. This is the
 * strictly more expensive class of dead code — a cohesive, tested, maintained
 * subsystem that nothing can actually invoke.
 *
 * "Reachable" here means reachable from the source tree. A subsystem invoked
 * only by `scripts/` is still reported, because the running application cannot
 * reach it; the evidence says so rather than implying the code is unused.
 */
export function findOrphanSubsystems(files: readonly SourceFile[]): Finding[] {
  const imports = importedModuleIds(files);
  const groups = new Map<string, SourceFile[]>();
  for (const file of files) {
    const [root, dir, ...rest] = file.path.split("/");
    if (root !== "src" || rest.length === 0) continue; // top-level file, not a subsystem
    groups.set(dir!, [...(groups.get(dir!) ?? []), file]);
  }

  const findings: Finding[] = [];
  for (const [dir, members] of groups) {
    const prefix = `src/${dir}/`;
    const memberIds = new Set(members.map((m) => moduleIdOf(m.path)));
    const isReachable = files.some(
      (o) => !o.path.startsWith(prefix) && [...imports.get(o.path)!].some((id) => memberIds.has(id)),
    );
    if (isReachable) continue;

    findings.push({
      kind: "orphan-module",
      subject: prefix,
      evidence:
        `The ${members.length} modules under ${prefix} import each other but nothing outside the ` +
        `directory imports any of them, so the running application cannot reach this subsystem ` +
        `(scripts or tests may still invoke it directly).`,
      severity: "high",
      location: prefix,
    });
  }
  return findings;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Declared dependencies never imported anywhere in the source tree.
 *
 * The import is matched quote-delimited, allowing a subpath: `"pkg"` and
 * `"pkg/sub"` both count, while `"pkg-other"` does not. Plain prefix matching
 * would score `@langchain/langgraph-checkpoint` as use of `@langchain/langgraph`.
 */
export function findUnusedDependencies(
  files: readonly SourceFile[],
  dependencies: readonly string[],
): Finding[] {
  return dependencies.flatMap((dep) => {
    const importRe = new RegExp(`["']${escapeForRegex(dep)}(?:/[^"']*)?["']`);
    if (files.some((f) => importRe.test(f.text))) return [];

    return [
      {
        kind: "unused-dependency",
        subject: dep,
        evidence:
          `"${dep}" is declared as a dependency but is never imported in the source tree. ` +
          `It is installed and shipped on every deploy for nothing.`,
        severity: "medium",
      } satisfies Finding,
    ];
  });
}
