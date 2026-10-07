/**
 * Mac capture records for the VPS brain (AG-027). Pure: builders and validators over text already read.
 * No fs, no database, no LLM. The Mac collector (scripts/brain-capture.ts) reads files and calls these;
 * the VPS ingester (scripts/brain-ingest-digests.ts) validates with the same schema.
 *
 * A record is a DIGEST: titles, founder prompts, files touched, the final answer. Never tool results.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { brainProvenanceSchema } from "../db/brain-provenance.js";
import { distillSession } from "./claude-transcript.js";
import { extractSessionFacts } from "./claude-session-facts.js";
import { findSecrets } from "./secret-scrub.js";

/** Records the VPS accepts per run; the first backfill spreads over several runs. */
export const MAX_RECORDS_PER_RUN = 200;
/** Whole session digest, characters. */
export const SESSION_CONTENT_MAX = 4000;
/** Session title, characters. */
export const TITLE_MAX = 120;
/** Founder prompts kept per session, and characters per prompt. */
export const MAX_PROMPTS = 10;
export const PROMPT_MAX = 300;
/** Final assistant message, characters. */
export const FINAL_MESSAGE_MAX = 1200;
/** Edited files listed per session. */
export const MAX_EDITED_FILES = 15;
/** A memory file longer than this is cut: it is embedded as one row. */
export const MEMORY_CONTENT_MAX = 6000;
/** Antigravity walkthrough/plan text kept, characters. */
export const AGY_DOC_MAX = 2500;
/** Upper bound the schema accepts for any record's content. */
export const RECORD_CONTENT_MAX = 8000;
/** Sessions with no founder prompt carry nothing worth a row. */
const MIN_PROMPTS = 1;

const MAC_ORIGINS = ["mac-claude", "mac-agy"] as const;

export const digestMetadataSchema = brainProvenanceSchema
  .extend({ origin: z.enum(MAC_ORIGINS), visibility: z.literal("founder") })
  .passthrough();

export const digestRecordSchema = z.object({
  source: z.enum(MAC_ORIGINS),
  source_id: z.string().min(1),
  memory_type: z.enum(["claude_memory", "session"]),
  project: z.string().min(1).nullable(),
  content: z.string().min(1).max(RECORD_CONTENT_MAX),
  metadata: digestMetadataSchema,
});
export type DigestRecord = z.infer<typeof digestRecordSchema>;

/** Lists the memory files present for one Claude project dir, so the VPS can archive deleted ones. */
export const manifestRecordSchema = z.object({
  source: z.literal("mac-claude"),
  source_id: z.string().min(1),
  memory_type: z.literal("claude_manifest"),
  project: z.string().min(1).nullable(),
  content: z.literal(""),
  metadata: z.object({ slug: z.string().min(1), source_ids: z.array(z.string().min(1)).max(5000) }),
});
export type ManifestRecord = z.infer<typeof manifestRecordSchema>;

export interface CaptureContext {
  readonly home: string;
  readonly machine: string;
  /** IANA zone, APP_TIMEZONE. */
  readonly timeZone: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const oneLine = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

export const hashRecord = (r: DigestRecord): string => sha256(`${r.project ?? ""}\n${r.content}`);

/** `~/Projects/<name>/...` gives `<name>`, `~/Oplify.in/...` gives `oplify`, anything else null. */
export function projectFromPath(path: string, home: string): string | null {
  const projects = `${home}/Projects/`;
  if (path.startsWith(projects)) return path.slice(projects.length).split("/")[0] || null;
  const oplify = `${home}/Oplify.in`;
  if (path === oplify || path.startsWith(`${oplify}/`)) return "oplify";
  return null;
}

/** "2026-10-06 14:05" in `timeZone`. */
export function formatLocal(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const tildePath = (path: string, home: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** Claude Code session digest, or null when the session has no founder prompt. */
export function buildSessionRecord(
  jsonlText: string, sessionId: string, fallbackTime: Date, ctx: CaptureContext,
): DigestRecord | null {
  const distilled = distillSession(jsonlText, sessionId);
  const facts = extractSessionFacts(jsonlText);
  const prompts = distilled.turns.filter((t) => t.role === "user").slice(0, MAX_PROMPTS);
  if (prompts.length < MIN_PROMPTS) return null;

  const title = oneLine(facts.title ?? prompts[0]!.text, TITLE_MAX);
  const project = facts.cwd ? projectFromPath(facts.cwd, ctx.home) : null;
  const repo = project ?? (facts.cwd ? facts.cwd.split("/").filter(Boolean).pop() : undefined);
  const lastAnswer = [...distilled.turns].reverse().find((t) => t.role === "assistant");
  const started = facts.startedAt ?? fallbackTime;
  const ended = facts.endedAt ?? distilled.lastActivity ?? fallbackTime;

  const sections = [
    `Claude Code session: ${title}`,
    `Repo: ${repo ?? "unknown"}${facts.branch ? `, branch ${facts.branch}` : ""}`,
    facts.prLinks.length > 0 ? `PRs: ${facts.prLinks.join(", ")}` : "",
    `Time: ${formatLocal(started, ctx.timeZone)} to ${formatLocal(ended, ctx.timeZone)} (${ctx.timeZone})`,
    `Founder prompts:\n${prompts.map((p) => `- ${oneLine(p.text, PROMPT_MAX)}`).join("\n")}`,
    facts.editedFiles.length > 0
      ? `Files edited:\n${facts.editedFiles.slice(0, MAX_EDITED_FILES).map((f) => `- ${tildePath(f, ctx.home)}`).join("\n")}`
      : "",
    lastAnswer ? `Final message: ${oneLine(lastAnswer.text, FINAL_MESSAGE_MAX)}` : "",
  ].filter(Boolean);

  return digestRecordSchema.parse({
    source: "mac-claude", source_id: sessionId, memory_type: "session", project,
    content: sections.join("\n").slice(0, SESSION_CONTENT_MAX),
    metadata: {
      origin: "mac-claude", client: "claude-code", machine: ctx.machine, session_id: sessionId,
      ...(repo ? { repo } : {}), occurred_at: ended.toISOString(), visibility: "founder",
      title, ...(facts.branch ? { branch: facts.branch } : {}),
    },
  });
}

export interface MemoryFile {
  readonly path: string;
  readonly text: string;
  readonly mtime: Date;
  /** Claude project dir name, the grouping key for the manifest. */
  readonly slug: string;
}

export const memorySourceId = (path: string): string => sha256(path);

export function buildMemoryRecord(file: MemoryFile, project: string | null, ctx: CaptureContext): DigestRecord | null {
  const text = file.text.trim();
  if (!text) return null;
  return digestRecordSchema.parse({
    source: "mac-claude", source_id: memorySourceId(file.path), memory_type: "claude_memory", project,
    content: text.slice(0, MEMORY_CONTENT_MAX),
    metadata: {
      origin: "mac-claude", client: "claude-code", machine: ctx.machine, ...(project ? { repo: project } : {}),
      occurred_at: file.mtime.toISOString(), visibility: "founder", slug: file.slug, file: file.path.split("/").pop(),
    },
  });
}

export function buildManifestRecord(slug: string, project: string | null, sourceIds: readonly string[]): ManifestRecord {
  return manifestRecordSchema.parse({
    source: "mac-claude", source_id: `manifest:${slug}`, memory_type: "claude_manifest", project, content: "",
    metadata: { slug, source_ids: [...sourceIds] },
  });
}

/** One row of Antigravity's conversation_summaries table. */
export interface AgyConversation {
  readonly conversation_id: string;
  readonly title: string;
  readonly preview: string;
  readonly step_count: number;
  readonly last_modified_time: string;
  /** JSON array of file:// URIs. */
  readonly workspace_uris: string;
}

function workspaceOf(raw: string): string | null {
  try {
    const first: unknown = (JSON.parse(raw) as unknown[])[0];
    return typeof first === "string" ? decodeURIComponent(first.replace(/^file:\/\//, "")) : null;
  } catch {
    return null; // allow-failopen: an unreadable workspace column only costs the project tag
  }
}

/** Antigravity conversation digest; `doc` is walkthrough.md, else implementation_plan.md, else null. */
export function buildAgyRecord(row: AgyConversation, doc: string | null, ctx: CaptureContext): DigestRecord | null {
  const workspace = workspaceOf(row.workspace_uris);
  const project = workspace ? projectFromPath(workspace, ctx.home) : null;
  const modified = new Date(row.last_modified_time);
  const title = oneLine(row.title || row.preview, TITLE_MAX);
  if (!title || Number.isNaN(modified.getTime())) return null;
  const sections = [
    `Antigravity conversation: ${title}`,
    row.preview && row.preview !== row.title ? `Preview: ${oneLine(row.preview, PROMPT_MAX)}` : "",
    `Steps: ${row.step_count}; workspace: ${workspace ? tildePath(workspace, ctx.home) : "unknown"}`,
    `Last modified: ${formatLocal(modified, ctx.timeZone)} (${ctx.timeZone})`,
    doc?.trim() ? `Notes:\n${doc.trim().slice(0, AGY_DOC_MAX)}` : "",
  ].filter(Boolean);
  return digestRecordSchema.parse({
    source: "mac-agy", source_id: row.conversation_id, memory_type: "session", project,
    content: sections.join("\n").slice(0, SESSION_CONTENT_MAX),
    metadata: {
      origin: "mac-agy", client: "antigravity", machine: ctx.machine, session_id: row.conversation_id,
      ...(project ? { repo: project } : {}), occurred_at: modified.toISOString(), visibility: "founder", title,
    },
  });
}

/** Pattern names found in a record's content or title. Never the text. */
export const secretsIn = (r: DigestRecord): readonly string[] =>
  findSecrets(`${r.content}\n${typeof r.metadata["title"] === "string" ? r.metadata["title"] : ""}`);

export interface ParsedDigestInput {
  readonly records: readonly DigestRecord[];
  readonly manifests: readonly ManifestRecord[];
  readonly invalid: number;
  readonly overCap: number;
  /** `source:source_id` of each record dropped for a secret. Never content. */
  readonly dropped: readonly string[];
}

/** VPS side: JSONL text to validated, re-scrubbed, capped records. */
export function parseDigestInput(text: string, cap: number = MAX_RECORDS_PER_RUN): ParsedDigestInput {
  const records: DigestRecord[] = [];
  const manifests: ManifestRecord[] = [];
  const dropped: string[] = [];
  let invalid = 0;
  let overCap = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      invalid += 1;
      continue; // allow-failopen: counted in the summary line as skipped
    }
    const manifest = manifestRecordSchema.safeParse(json);
    if (manifest.success) {
      manifests.push(manifest.data);
      continue;
    }
    const record = digestRecordSchema.safeParse(json);
    if (!record.success) {
      invalid += 1;
    } else if (secretsIn(record.data).length > 0) {
      dropped.push(`${record.data.source}:${record.data.source_id}`);
    } else if (records.length >= cap) {
      overCap += 1;
    } else {
      records.push(record.data);
    }
  }
  return { records, manifests, invalid, overCap, dropped };
}
