/**
 * FounderOS — Synthesized Skill Loader
 * =====================================
 * `synthesize_skill` (src/tools/skill-synthesizer.ts) writes + typechecks a
 * TypeScript tool module into src/tools/custom/ and then does NOTHING ELSE —
 * `DEPARTMENT_TOOLS` never sees it, so only a human hand-editing
 * capabilities.ts made it callable. This module is the missing registration
 * step: a boot-time loader, modeled directly on the existing late-merge
 * pattern `applyMcpBridge()` already uses for external MCP tools
 * (src/agents/capabilities.ts) — same phase (before buildWorkerSpecs reads
 * DEPARTMENT_TOOLS), same "mutate the shared record in place" mechanism, same
 * per-item failure isolation so one bad item never takes the merge down.
 *
 * ── Flag discipline ──────────────────────────────────────────────────────
 * Reads `process.env["SKILL_SYNTHESIS_ENABLED"]` at CALL time, not the frozen
 * `env` export from src/core/config.ts — the exact pattern kernel-boot.ts's
 * `isUnconfiguredTool` already uses for the same flag, for the same reason: a
 * gate nobody can flip inside a test is a gate nobody can prove is closed.
 * Off means a COMPLETE no-op — not even a `readdir` — so the off-state is
 * trivially provable with a readdir spy (see the loader test).
 *
 * ── Untrusted-input discipline ───────────────────────────────────────────
 * A file in src/tools/custom was written by an LLM tool call, not reviewed by
 * a human. At LOAD time this module treats it exactly like external input:
 *   - the registered name is RE-DERIVED from the filename with
 *     `sanitizeSkillName` — the exact function `synthesizeSkillImpl` used at
 *     WRITE time (src/tools/skill-synthesizer.ts). Whatever the module's own
 *     `.name` export claims about itself is never trusted for identity.
 *   - a re-derived name that collides with any tool already present across
 *     every department (built-in OR already-bridged MCP) is REJECTED, never
 *     merged — a synthesized tool must never shadow an existing one.
 *   - a module that throws on import, or does not export anything shaped
 *     like a KernelTool (`name: string`, `invoke: function` — the exact
 *     structural contract src/kernel/worker.ts's `KernelTool` interface
 *     requires, and the same shape every existing LangChain `tool()` wrapper
 *     in this codebase already satisfies), is skipped with a loud log entry
 *     and never crashes boot.
 *
 * ── Validation bar: duck-typing, not a second `tsc --noEmit` ────────────
 * `synthesizeSkillImpl` already ran a full-project typecheck before ever
 * writing the file, and `pnpm gate`'s `tsc --noEmit` covers the same file
 * again on every CI run because it lives under src/. Re-running a full-project
 * compiler invocation on EVERY boot — before Postgres is even confirmed
 * reachable (see kernel-boot.ts's getKernel()) — would be a slow, redundant
 * spawn for a check already made twice elsewhere. The runtime duck-type check
 * (`looksLikeKernelTool`) is the load-bearing gate here by design.
 *
 * ── Why `.ts` isn't `import()`-ed directly ───────────────────────────────
 * Production runs `node dist/src/index.js` (package.json's `start` script) —
 * no `tsx` loader is registered in that process, and relying on Node's own
 * native TypeScript handling would silently couple this feature's prod
 * behaviour to the exact Node minor version and syntax subset deployed,
 * neither of which this change can verify. Instead each file is transpiled
 * with the `typescript` compiler API (already a devDependency; `deploy.sh:44`
 * runs `pnpm install --frozen-lockfile` with NO `--prod`, so it IS present in
 * the prod `node_modules` — the same reliance `skill-synthesizer.ts` already
 * has on the `tsc` binary at runtime) into plain ESM, written to
 * `.synthesized-cache/` at the project root (gitignored, deliberately NOT
 * under `node_modules/` so a concurrent `pnpm install` on deploy can never
 * race it away mid-boot), then dynamically `import()`-ed from there. Being
 * inside the project tree, Node's normal module resolution walks up to the
 * real `node_modules` for bare specifiers like `"zod"` or
 * `"@langchain/core/tools"` — verified by hand against this exact dependency
 * set (see the PR body for the standalone repro).
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { childLogger } from "../infra/logger.js";
import { CUSTOM_TOOLS_DIR, sanitizeSkillName } from "../tools/skill-synthesizer.js";
import { DEPARTMENT_TOOLS } from "./capabilities.js";

const log = childLogger({ module: "agents:skill-loader" });

// Tool generics are heterogeneous across departments (mirrors capabilities.ts'
// own AnyTool — same reasoning: the graph only needs `.name` + invokability).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

/** Where transpiled synthesized modules are written before being imported.
 *  Inside the project tree (NOT under node_modules/) so bare-specifier
 *  resolution finds the real node_modules and a `pnpm install` mid-deploy
 *  can't delete it out from under an in-flight boot. Gitignored. */
const COMPILED_CACHE_DIR = path.resolve("./.synthesized-cache");

/**
 * Department synthesized tools are registered under. Chosen deliberately —
 * not left ambiguous:
 *   `admin` already carries synthesize_skill itself, and is the ONE
 *   department whose existing roster (recordEvent, opsState,
 *   listPendingSignals, …) is general/administrative rather than tied to one
 *   domain (research, sales, comms, …). A synthesized tool's domain is
 *   whatever the founder happened to ask for at synthesis time — arbitrary by
 *   construction — so it fits the general-utility department, not a
 *   domain-specific one. `engineering` was the other candidate (it also
 *   carries synthesize_skill) but is scoped to code/build/deploy work
 *   specifically; a synthesized weather-lookup or pricing-scrape tool has no
 *   home there.
 */
export const SYNTHESIZED_SKILLS_DEPARTMENT = "admin";

/** Non-enumerable marker so a re-run of this loader (e.g. `/connect`'s
 *  resetKernelCache() forcing a kernel rebuild) can strip its OWN previous
 *  merge before re-merging — the same idempotency `stripBridgedTools` gives
 *  applyMcpBridge, applied here so repeated boots never duplicate a
 *  synthesized tool in the department array. */
const SYNTHESIZED_MARKER = "__founderosSynthesized";

function markSynthesized(tool: AnyTool): void {
  Object.defineProperty(tool, SYNTHESIZED_MARKER, { value: true, enumerable: false, configurable: true });
}

/** Structural KernelTool duck-type: `name: string`, `invoke: function` — the
 *  exact contract src/kernel/worker.ts's KernelTool interface requires, and
 *  the shape every LangChain `tool()` wrapper already in this codebase has. */
function looksLikeKernelTool(value: unknown): value is { name: string; invoke: (...args: unknown[]) => unknown } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v["name"] === "string" && v["name"].length > 0 && typeof v["invoke"] === "function";
}

/** First export (default checked first, then named, in declaration order)
 *  that duck-types as a KernelTool. Null if the module exports nothing usable. */
function findToolExport(mod: Record<string, unknown>): AnyTool | null {
  if (looksLikeKernelTool(mod["default"])) return mod["default"];
  for (const [key, value] of Object.entries(mod)) {
    if (key === "default") continue;
    if (looksLikeKernelTool(value)) return value;
  }
  return null;
}

/** Transpile TS source to plain ESM JS with the (already-relied-upon)
 *  `typescript` compiler API. See module doc for why a raw `.ts` dynamic
 *  import is not a safe foundation for the production entrypoint. */
export function transpileSkillSource(source: string): string {
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  return out.outputText;
}

/** Injectable seams — production uses real fs + dynamic import; tests inject
 *  fakes so no file ever touches disk and no real module is ever imported. */
export interface SkillLoaderDeps {
  readdir: (dir: string) => Promise<string[]>;
  readFile: (file: string) => Promise<string>;
  writeCompiled: (file: string, contents: string) => Promise<void>;
  importModule: (fileUrl: string) => Promise<Record<string, unknown>>;
}

const defaultDeps: SkillLoaderDeps = {
  readdir: (dir) => fsp.readdir(dir),
  readFile: (file) => fsp.readFile(file, "utf-8"),
  writeCompiled: async (file, contents) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, contents, "utf-8");
  },
  importModule: (fileUrl) => import(fileUrl) as Promise<Record<string, unknown>>,
};

export interface LoadedSkill {
  name: string;
  tool: AnyTool;
}

export interface SkillLoadOutcome {
  loaded: LoadedSkill[];
  skippedCount: number;
}

function collectBuiltInToolNames(target: Record<string, AnyTool[]>): Set<string> {
  const names = new Set<string>();
  for (const tools of Object.values(target)) {
    for (const t of tools) {
      if (t && typeof t.name === "string") names.add(t.name);
    }
  }
  return names;
}

/**
 * Load every validated synthesized tool from src/tools/custom/*.ts. A
 * COMPLETE no-op — no `readdir`, no I/O at all — when the flag is off.
 * `builtInNames` is the collision set computed by the caller BEFORE this
 * loader's own tools are merged in (applySkillSynthesisLoader below wires
 * that ordering).
 */
export async function loadSynthesizedSkills(
  builtInNames: ReadonlySet<string>,
  deps: SkillLoaderDeps = defaultDeps,
): Promise<SkillLoadOutcome> {
  if (process.env["SKILL_SYNTHESIS_ENABLED"] !== "true") {
    return { loaded: [], skippedCount: 0 };
  }

  let entries: string[];
  try {
    entries = await deps.readdir(CUSTOM_TOOLS_DIR);
  } catch (err) {
    // ENOENT — no skill has ever been synthesized yet — is the ordinary
    // steady state, not a failure. Everything else is still non-fatal: a
    // synthesis pipeline that can't read its own output directory degrades
    // to "zero synthesized tools loaded", never to a broken boot.
    log.info(
      { dir: CUSTOM_TOOLS_DIR, err: (err as Error).message },
      "Synthesized-tools directory unreadable (or does not exist yet) — zero tools loaded",
    );
    return { loaded: [], skippedCount: 0 };
  }

  const tsFiles = entries.filter((f) => f.endsWith(".ts"));
  const loaded: LoadedSkill[] = [];
  let skippedCount = 0;

  for (const file of tsFiles) {
    try {
      const rawBase = file.slice(0, -3);
      // Untrusted-input discipline: re-derive the name from the FILENAME with
      // the same sanitizer used at write time. Never trust the module's own
      // internal `.name` claim for identity/collision purposes.
      const name = sanitizeSkillName(rawBase);

      if (builtInNames.has(name)) {
        skippedCount++;
        log.error(
          { file, name },
          "Synthesized tool name collides with an existing tool — skipped, NOT merged, will never shadow the existing one",
        );
        continue;
      }

      const source = await deps.readFile(path.join(CUSTOM_TOOLS_DIR, file));
      const compiledPath = path.join(COMPILED_CACHE_DIR, `${name}.mjs`);
      await deps.writeCompiled(compiledPath, transpileSkillSource(source));

      const mod = await deps.importModule(`file://${compiledPath}`);
      const found = findToolExport(mod);
      if (!found) {
        skippedCount++;
        log.error(
          { file, name },
          "Synthesized module has no export shaped like a tool (name: string, invoke: function) — skipped",
        );
        continue;
      }

      // Registration identity is the re-derived, re-sanitized name — never
      // the module's own claim — even when the export duck-types fine.
      // `.name` is a plain writable own property on every existing
      // LangChain `tool()` result (verified by hand; not a getter), so this
      // mutates identity in place without breaking `.invoke`/`.schema`/etc.
      found.name = name;
      markSynthesized(found);
      loaded.push({ name, tool: found });
      log.info({ file, name }, "Synthesized tool loaded and validated — merging on this boot");
    } catch (err) {
      skippedCount++;
      log.error(
        { file, err: (err as Error).message },
        "Synthesized tool failed to load (threw during transpile/import) — skipped, boot continues",
      );
    }
  }

  return { loaded, skippedCount };
}

/** Remove any tool this loader merged on a PREVIOUS run (identified by the
 *  non-enumerable marker, never by name) so a kernel rebuild — e.g.
 *  `/connect` calling resetKernelCache() — can re-merge without duplicating
 *  entries. Mirrors capabilities.ts' stripBridgedTools for the same reason. */
export function stripSynthesizedTools(target: Record<string, AnyTool[]> = DEPARTMENT_TOOLS): void {
  const dept = target[SYNTHESIZED_SKILLS_DEPARTMENT];
  if (!dept) return;
  target[SYNTHESIZED_SKILLS_DEPARTMENT] = dept.filter((t) => !t?.[SYNTHESIZED_MARKER]);
}

/**
 * Boot-time entry point — call alongside `applyMcpBridge()` in
 * kernel-boot.ts's `getKernel()`, same phase, before `buildWorkerSpecs()`
 * reads `DEPARTMENT_TOOLS`. Strips any previous merge (idempotent), computes
 * the collision set from the CURRENT registry (built-ins + already-bridged
 * MCP tools, since applyMcpBridge runs first), loads + validates, and merges.
 */
export async function applySkillSynthesisLoader(
  target: Record<string, AnyTool[]> = DEPARTMENT_TOOLS,
  deps?: SkillLoaderDeps,
): Promise<SkillLoadOutcome> {
  stripSynthesizedTools(target);
  const builtInNames = collectBuiltInToolNames(target);
  const outcome = await loadSynthesizedSkills(builtInNames, deps);
  for (const { tool } of outcome.loaded) {
    (target[SYNTHESIZED_SKILLS_DEPARTMENT] ??= []).push(tool);
  }
  if (outcome.loaded.length > 0 || outcome.skippedCount > 0) {
    log.info(
      { loaded: outcome.loaded.map((s) => s.name), skippedCount: outcome.skippedCount },
      "Synthesized-skill boot load complete",
    );
  }
  return outcome;
}
