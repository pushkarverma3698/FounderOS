/**
 * FounderOS - coding pipeline v2: Pass P decisions (AGENT_PIPELINE_V2=1)
 * ======================================================================
 * Pass P runs Claude (as `claude-agent`, on a read-only copy of the repo) to turn the founder's ask into a
 * TaskContract and a locked test. The model is untrusted. Everything that decides what happens next is in this
 * file, as pure functions that deploy/lib/pass-p.sh reaches through scripts/pipeline-spec.ts:
 *  - extractAsk: the founder's words, read back byte for byte from the issue (the section dispatch-spec-intake.ts wrote);
 *  - assembleContract: the model supplies the spec; CODE supplies ask, repo, base_sha, version and every citation's
 *    sha, and a limit the model asks for can only be lower than the default, never higher;
 *  - checkChanges: the run may write the declared locked-test files and one JSON file, nothing else. A symlink, a
 *    deleted file, an oversized file or any other path rejects the whole run;
 *  - runPassP: PASS (a card goes to the founder), ASK (the spec gate has questions: no card, the founder is asked) or
 *    REJECT (the run itself was wrong: counted as a failed attempt, never shown as a spec).
 * Nothing here reads a file or runs a command: the manifest and the line counts arrive as data, so every refusal is
 * fixture-tested offline.
 */

import { VERBATIM_HEADING } from "./dispatch-spec-intake.js";
import { runSpecGate } from "./spec-gate.js";
import { parseTaskContract } from "./task-contract.js";
import type { Risk, TaskContract, TaskLimits } from "./task-contract.js";

/** The one non-test file the run may write. */
export const SPEC_OUT_FILE = ".spec-out/contract.json";
const SPEC_OUT_DIR = ".spec-out/";

/** Largest contract.json read back, and largest locked-test file accepted. */
export const MAX_CONTRACT_BYTES = 64 * 1024;
export const MAX_TEST_BYTES = 200 * 1024;
export const MAX_TEST_FILES = 5;

/** What a task may change unless the model asks for less. Chosen here, not derived: no plan fixes these numbers. */
export const DEFAULT_LIMITS: TaskLimits = { files: 10, lines: 400, deleted_lines: 150, new_dependencies: false };

/**
 * Paths whose change is always high risk (the plan's Full triggers: schema, deploy, infra). Static prefixes only: a glob
 * that begins with a wildcard overlaps every scope (globsOverlap is conservative), which would make everything "high".
 */
export const DEFAULT_RISK_PATHS: readonly string[] = ["src/db/**", "drizzle/**", "migrations/**", "deploy/**", "src/infra/**", "infra/**"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------- the ask

export type AskResult = { ok: true; ask: string } | { ok: false; error: string };

const HEADING_LINE = "## " + VERBATIM_HEADING;
const OPEN_FENCE = /^(`{3,})$/;

/**
 * The text inside the `## Founder request (verbatim)` fence, exactly as it was written. The section must be the last
 * thing in the body: a body edited after filing (text added below the fence) is refused, not guessed at. When the
 * heading appears more than once the earliest one whose fence closes at the end of the body is the section, so a
 * heading typed inside the ask cannot take its place.
 */
export function extractAsk(body: string): AskResult {
  const lines = body.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trimEnd() !== HEADING_LINE) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
    const open = OPEN_FENCE.exec((lines[j] ?? "").trimEnd());
    const fence = open?.[1];
    if (fence === undefined) continue;
    let k = j + 1;
    while (k < lines.length && (lines[k] ?? "").trimEnd() !== fence) k++;
    if (k !== lines.length - 1) continue;
    const ask = lines.slice(j + 1, k).join("\n");
    if (ask.trim() === "") return { ok: false, error: "the founder's request in the issue is blank" };
    return { ok: true, ask };
  }
  return { ok: false, error: `the issue has no "${HEADING_LINE}" section ending the body, so there is no ask to bind the spec to` };
}

// ---------------------------------------------------------------- the contract

export interface ContractContext {
  ask: string;
  repo: string;
  base_sha: string;
}
export type AssembleResult = { ok: true; contract: TaskContract } | { ok: false; errors: string[] };

function limitFrom(model: unknown, def: number): number {
  return typeof model === "number" && Number.isInteger(model) && model > 0 && model < def ? model : def;
}

/** Build the TaskContract from untrusted model JSON and the facts code knows. Never repairs; reports every problem. */
export function assembleContract(model: unknown, ctx: ContractContext): AssembleResult {
  if (!isObj(model)) return { ok: false, errors: ["contract: the model's output must be one JSON object"] };
  const behavior = model.current_behavior;
  const current_behavior = isObj(behavior)
    ? {
        text: behavior.text,
        citations: Array.isArray(behavior.citations)
          ? behavior.citations.map((c) => (isObj(c) ? { path: c.path, line: c.line, sha: ctx.base_sha } : c))
          : behavior.citations,
      }
    : behavior;
  const asked = isObj(model.limits) ? model.limits : {};
  const limits: TaskLimits = {
    files: limitFrom(asked.files, DEFAULT_LIMITS.files),
    lines: limitFrom(asked.lines, DEFAULT_LIMITS.lines),
    deleted_lines: limitFrom(asked.deleted_lines, DEFAULT_LIMITS.deleted_lines),
    new_dependencies: false,
  };
  const parsed = parseTaskContract({
    version: 1,
    ask: ctx.ask,
    repo: ctx.repo,
    task_type: model.task_type,
    base_sha: ctx.base_sha,
    current_behavior,
    expected_behavior: model.expected_behavior,
    scope: model.scope,
    locked_tests: model.locked_tests,
    oracle: model.oracle,
    risk: model.risk,
    limits,
  });
  return parsed.ok ? { ok: true, contract: parsed.contract } : { ok: false, errors: parsed.errors };
}

// ---------------------------------------------------------------- what the run wrote

export interface ManifestEntry {
  /** git status --porcelain v1 code, two characters: "??" new, " M" modified, " D" deleted. */
  status: string;
  /** file | symlink | other | missing, as the dispatcher saw it. */
  type: string;
  size: number;
  path: string;
}
export type ManifestResult = { ok: true; entries: ManifestEntry[] } | { ok: false; error: string };

/** `<status>\t<type>\t<size>\t<path>` per line, as deploy/lib/pass-p.sh prints it. Anything else is an error. */
export function parseManifest(text: string): ManifestResult {
  const entries: ManifestEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\t");
    const [status, type, size, ...rest] = parts;
    const path = rest.join("\t");
    if (parts.length < 4 || status === undefined || type === undefined || size === undefined || !/^\d+$/.test(size) || path === "") {
      return { ok: false, error: "malformed change manifest line: " + JSON.stringify(line.slice(0, 120)) };
    }
    entries.push({ status, type, size: Number(size), path });
  }
  return { ok: true, entries };
}

export type ChangesResult = { ok: true; testFiles: string[] } | { ok: false; reasons: string[] };

const safeRelative = (p: string): boolean =>
  p !== "" && !p.startsWith("/") && !p.includes("\\") && !/[\u0000-\u001f]/.test(p) && !p.split("/").some((s) => s === ".." || s === "");

/**
 * The run may add or edit the declared locked tests and write SPEC_OUT_FILE. Every other change, a deleted file, a
 * symlink, a file over the size cap, or a declared test that was not written, rejects the run.
 */
export function checkChanges(entries: readonly ManifestEntry[], contract: TaskContract): ChangesResult {
  const reasons: string[] = [];
  const locked = new Set(contract.locked_tests);
  if (locked.size > MAX_TEST_FILES) reasons.push(`the spec names ${locked.size} locked tests; at most ${MAX_TEST_FILES} are accepted`);
  const written = new Set<string>();
  let sawContract = false;
  for (const e of entries) {
    if (!safeRelative(e.path)) {
      reasons.push("the run wrote an unsafe path: " + JSON.stringify(e.path.slice(0, 120)));
      continue;
    }
    if (e.status !== "??" && e.status !== " M") {
      reasons.push(`the run changed ${e.path} with status "${e.status}": only added or edited files are accepted`);
    } else if (e.type !== "file") {
      reasons.push(`the run wrote ${e.path} as a ${e.type}: only regular files are accepted`);
    } else if (e.path === SPEC_OUT_FILE) {
      sawContract = true;
      if (e.size > MAX_CONTRACT_BYTES) reasons.push(`${SPEC_OUT_FILE} is ${e.size} bytes, over the ${MAX_CONTRACT_BYTES} limit`);
    } else if (e.path.startsWith(SPEC_OUT_DIR)) {
      reasons.push(`the run wrote ${e.path}: only ${SPEC_OUT_FILE} is allowed under ${SPEC_OUT_DIR}`);
    } else if (!locked.has(e.path)) {
      reasons.push(`the run changed ${e.path}, which is not one of the declared locked tests`);
    } else if (e.size > MAX_TEST_BYTES) {
      reasons.push(`locked test ${e.path} is ${e.size} bytes, over the ${MAX_TEST_BYTES} limit`);
    } else if (e.size === 0) {
      reasons.push(`locked test ${e.path} is empty`);
    } else {
      written.add(e.path);
    }
  }
  if (!sawContract) reasons.push(`the run did not write ${SPEC_OUT_FILE}`);
  for (const t of locked) if (!written.has(t)) reasons.push(`the declared locked test ${t} was not written`);
  return reasons.length === 0 ? { ok: true, testFiles: [...locked].sort() } : { ok: false, reasons };
}

// ---------------------------------------------------------------- the decision

export interface PassPInput {
  issue_body: string;
  repo: string;
  base_sha: string;
  /** The text of SPEC_OUT_FILE. */
  model_output: string;
  /** The change manifest (parseManifest's input). */
  manifest: string;
  /** Lines in each cited file at base_sha; null or absent means the file is not there. */
  line_counts: Record<string, number | null | undefined>;
  risk_paths?: readonly string[];
}

export type PassPResult =
  | { status: "PASS"; contract: TaskContract; effective_risk: Risk; fingerprint: string; test_files: string[] }
  | { status: "ASK"; contract: TaskContract; questions: string[]; effective_risk: Risk; fingerprint: string }
  | { status: "REJECT"; reasons: string[] };

const reject = (...reasons: string[]): PassPResult => ({ status: "REJECT", reasons });

export function runPassP(input: PassPInput): PassPResult {
  const ask = extractAsk(input.issue_body);
  if (!ask.ok) return reject(ask.error);
  let raw: unknown;
  try {
    raw = JSON.parse(input.model_output);
  } catch (err) {
    return reject("the run's " + SPEC_OUT_FILE + " is not valid JSON: " + (err instanceof Error ? err.message : String(err)));
  }
  const assembled = assembleContract(raw, { ask: ask.ask, repo: input.repo, base_sha: input.base_sha });
  if (!assembled.ok) return reject(...assembled.errors);
  const manifest = parseManifest(input.manifest);
  if (!manifest.ok) return reject(manifest.error);
  const changes = checkChanges(manifest.entries, assembled.contract);
  if (!changes.ok) return reject(...changes.reasons);

  const gate = runSpecGate(assembled.contract, {
    fileLineCount: (path) => {
      const n = input.line_counts[path];
      return typeof n === "number" ? n : null;
    },
    riskPaths: [...(input.risk_paths ?? DEFAULT_RISK_PATHS)],
  });
  if (gate.status === "PASS") {
    return {
      status: "PASS",
      contract: assembled.contract,
      effective_risk: gate.effectiveRisk,
      fingerprint: gate.fingerprint,
      test_files: changes.testFiles,
    };
  }
  return { status: "ASK", contract: assembled.contract, questions: gate.questions, effective_risk: gate.effectiveRisk, fingerprint: gate.fingerprint };
}
