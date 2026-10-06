/**
 * FounderOS: Mac capture for the VPS brain (AG-027). Runs on the Mac, reads local Claude Code and Antigravity
 * work, and writes JSONL digests to stdout. No database, no LLM, no network.
 * `scripts/mac/brain-capture.sh` pipes stdout to `scripts/brain-ingest-digests.ts` on the VPS over ssh.
 *
 *   node --import tsx/esm scripts/brain-capture.ts [--dry-run] [--limit N] [--state FILE] [--state-out FILE]
 *
 * stdout: records only. stderr: one summary line, then one line per record dropped for a secret (path or id, never content).
 * The state file (path -> mtime + hash) is read from --state and the next state written to --state-out, which the
 * wrapper moves into place only after the VPS accepted the batch. --dry-run prints what would be sent and writes nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import {
  MAX_RECORDS_PER_RUN, buildAgyRecord, buildManifestRecord, buildMemoryRecord, buildSessionRecord, memorySourceId,
  projectFromPath, type AgyConversation, type CaptureContext, type DigestRecord, type ManifestRecord,
} from "../src/lib/brain-digest.js";
import { extractSessionFacts } from "../src/lib/claude-session-facts.js";
import { EMPTY_STATE, parseState, planRun, type Candidate, type CaptureState, type RunPlan } from "../src/lib/brain-capture-run.js";

export interface CollectInput {
  readonly ctx: CaptureContext;
  readonly claudeProjectsDir: string;
  readonly agyBrainDir: string;
  readonly agyRows: () => readonly AgyConversation[];
}

export interface Collected {
  readonly candidates: readonly Candidate[];
  /** Memory file paths by Claude project dir, for the manifest records. */
  readonly memoryBySlug: ReadonlyMap<string, { readonly project: string | null; readonly keys: readonly string[] }>;
}

const HEAD_BYTES = 128 * 1024;

/** First bytes of a file, cut at the last full line. Enough to find `cwd`. */
function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, n).toString("utf-8");
    return n < HEAD_BYTES ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
}

const listDir = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

/** The project a memory dir belongs to: the cwd of its newest session. Null when no session names one. */
function projectOfSlug(sessions: readonly { path: string; mtimeMs: number }[], home: string): string | null {
  const newest = [...sessions].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!newest) return null;
  const cwd = extractSessionFacts(readHead(newest.path)).cwd;
  return cwd ? projectFromPath(cwd, home) : null;
}

export function collect(input: CollectInput): Collected {
  const { ctx } = input;
  const candidates: Candidate[] = [];
  const memoryBySlug = new Map<string, { project: string | null; keys: string[] }>();

  for (const slug of listDir(input.claudeProjectsDir)) {
    const slugDir = join(input.claudeProjectsDir, slug);
    if (!statSync(slugDir).isDirectory()) continue;
    const sessions = listDir(slugDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ path: join(slugDir, f), id: f.slice(0, -".jsonl".length), mtimeMs: statSync(join(slugDir, f)).mtimeMs }));
    for (const s of sessions) {
      candidates.push({
        key: s.path, label: s.path, mtimeMs: s.mtimeMs,
        build: () => buildSessionRecord(readFileSync(s.path, "utf-8"), s.id, new Date(s.mtimeMs), ctx),
      });
    }

    const memoryDir = join(slugDir, "memory");
    const files = listDir(memoryDir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) continue;
    const project = projectOfSlug(sessions, ctx.home);
    memoryBySlug.set(slug, { project, keys: files.map((f) => join(memoryDir, f)) });
    for (const f of files) {
      const path = join(memoryDir, f);
      const mtimeMs = statSync(path).mtimeMs;
      candidates.push({
        key: path, label: path, mtimeMs,
        build: () => buildMemoryRecord({ path, text: readFileSync(path, "utf-8"), mtime: new Date(mtimeMs), slug }, project, ctx),
      });
    }
  }

  for (const row of input.agyRows()) {
    const mtimeMs = new Date(row.last_modified_time).getTime();
    if (Number.isNaN(mtimeMs)) continue;
    candidates.push({
      key: `agy:${row.conversation_id}`, label: `antigravity:${row.conversation_id}`, mtimeMs,
      build: () => buildAgyRecord(row, readAgyDoc(input.agyBrainDir, row.conversation_id), ctx),
    });
  }
  return { candidates, memoryBySlug };
}

/** walkthrough.md, else implementation_plan.md. The id comes from Antigravity's own db; guard the path anyway. */
function readAgyDoc(brainDir: string, id: string): string | null {
  if (!/^[\w-]+$/.test(id)) return null;
  for (const name of ["walkthrough.md", "implementation_plan.md"]) {
    const path = join(brainDir, id, name);
    if (existsSync(path)) return readFileSync(path, "utf-8");
  }
  return null;
}

/** Antigravity's summaries db through the macOS sqlite3 CLI. No npm dependency. */
export function readAgyRows(dbPath: string): AgyConversation[] {
  if (!existsSync(dbPath)) return [];
  const out = execFileSync(
    "sqlite3",
    ["-readonly", "-json", dbPath,
      "SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris FROM conversation_summaries WHERE killed = 0"],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.trim() ? (JSON.parse(out) as AgyConversation[]) : [];
}

/** One manifest per Claude project dir. Dropped files stay out, so a stale VPS row is archived. */
export function buildManifests(collected: Collected, droppedKeys: ReadonlySet<string>): ManifestRecord[] {
  return [...collected.memoryBySlug].map(([slug, m]) =>
    buildManifestRecord(slug, m.project, m.keys.filter((k) => !droppedKeys.has(k)).map(memorySourceId)),
  );
}

export function summaryLine(plan: RunPlan, manifests: number, dryRun: boolean): string {
  return `brain-capture${dryRun ? " (dry run)" : ""}: captured ${plan.records.length}, unchanged ${plan.unchanged}, ` +
    `deferred ${plan.deferred}, dropped-for-secrets ${plan.dropped.length}, manifests ${manifests}`;
}

export function toJsonl(records: readonly (DigestRecord | ManifestRecord)[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
}

interface Args { dryRun: boolean; limit: number; state: string; stateOut: string | null }

export function parseArgs(argv: readonly string[], home: string): Args {
  const args: Args = { dryRun: false, limit: MAX_RECORDS_PER_RUN, state: join(home, ".claude", "brain-capture-state.json"), stateOut: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--since-state") continue; // the state file is always used; the flag stays for the documented command line
    else if (a === "--limit") args.limit = Math.max(1, Math.min(MAX_RECORDS_PER_RUN, Number(argv[++i]) || MAX_RECORDS_PER_RUN));
    else if (a === "--state") args.state = argv[++i] ?? args.state;
    else if (a === "--state-out") args.stateOut = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

export function main(argv: readonly string[]): number {
  const home = homedir();
  const args = parseArgs(argv, home);
  const ctx: CaptureContext = { home, machine: hostname(), timeZone: process.env["APP_TIMEZONE"] || "Asia/Kolkata" };
  const collected = collect({
    ctx,
    claudeProjectsDir: join(home, ".claude", "projects"),
    agyBrainDir: join(home, ".gemini", "antigravity", "brain"),
    agyRows: () => readAgyRows(join(home, ".gemini", "antigravity", "conversation_summaries.db")),
  });
  const state: CaptureState = existsSync(args.state) ? parseState(readFileSync(args.state, "utf-8")) : EMPTY_STATE;
  const plan = planRun(collected.candidates, state, args.limit);
  const manifests = buildManifests(collected, plan.droppedKeys);

  console.error(summaryLine(plan, manifests.length, args.dryRun));
  for (const d of plan.dropped) console.error(`dropped ${d.label}: ${d.patterns.join(", ")}`);

  if (args.dryRun) {
    for (const r of plan.records) console.error(`would send ${r.source}:${r.memory_type} project=${r.project ?? "-"} chars=${r.content.length}`);
    return 0;
  }
  process.stdout.write(toJsonl([...plan.records, ...manifests]));
  if (args.stateOut) writeFileSync(args.stateOut, JSON.stringify(plan.nextState));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`brain-capture failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
