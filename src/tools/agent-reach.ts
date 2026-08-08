/**
 * FounderOS — Agent Reach Tool
 * =============================
 * Wraps the `agent-reach` toolchain (github.com/Panniantong/agent-reach) for the
 * kernel. Agent Reach is an installer/router, NOT a wrapper — so this tool calls
 * the upstream binaries it installs (yt-dlp) and the keyless HTTP endpoints it
 * selects (Jina Reader), exactly as its own docs prescribe.
 *
 * Scope is deliberately narrow — only capabilities the kernel does NOT already
 * have, verified by grep 2026-08-07:
 *   - youtube_transcript : NEW. No YouTube/yt-dlp path existed anywhere in src/.
 *   - readPageViaJina    : keyless page reader, wired as the LAST-RESORT tier of
 *                          scrapeUrl (src/tools/apify.ts) rather than as a rival
 *                          agent tool — a third page-reader in the planner's list
 *                          would be ambiguity, not capability.
 * Exa search was deliberately NOT wired: it duplicates search_web and would add
 * an mcporter runtime dependency on the VPS for no marginal capability.
 *
 * Every cookie/login channel (Twitter, Reddit, XiaoHongShu, Facebook, Instagram,
 * LinkedIn) is intentionally absent. They cannot work on a headless VPS without
 * shipping founder credentials to the box, and upstream issue #63 records a
 * dedicated burner account being banned anyway.
 *
 * Fail-soft: every path returns a ToolResult naming the real component. Never
 * throws — a missing binary is a typed failure, not a crash.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:agent_reach" });

const YTDLP_TIMEOUT_MS = 90_000;
const JINA_TIMEOUT_MS = 30_000;
const JINA_READER_BASE = "https://r.jina.ai/";
/** Transcript bound — a 3h stream must not blow the turn's token budget. */
export const TRANSCRIPT_MAX_CHARS = 24_000;
/** yt-dlp lives outside PATH under systemd; pipx's bin dir is the documented home. */
const YTDLP_CANDIDATES = ["yt-dlp", `${process.env["HOME"] ?? ""}/.local/bin/yt-dlp`];
/**
 * Native English only. A broad `en.*` glob matches the HUNDREDS of
 * auto-translated "English from <language>" tracks YouTube publishes; yt-dlp
 * downloads every match sequentially, which earns an HTTP 429 partway through
 * and aborts the run BEFORE it writes info.json (live-verified 2026-08-07 —
 * the mocked tests could not see this).
 */
export const SUB_LANGS_PRIMARY = "en,en-orig";
/** Second attempt, only if the primary found nothing: a foreign-language video
 *  whose sole English track is auto-translated (`en-<source>`). */
export const SUB_LANGS_TRANSLATED = "en-.*";

// ── CLI seam (injected in tests; spawns the real binary in production) ────────

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CliRunner = (bin: string, args: string[], opts?: { timeoutMs?: number }) => Promise<CliResult>;

/** Exit code used when we kill the child ourselves — mirrors coreutils `timeout`. */
export const CLI_TIMEOUT_CODE = 124;
/** Exit code for "binary not on PATH" — distinct so callers can name the real cause. */
export const CLI_ENOENT_CODE = 127;
const CLI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function makeCliRunner(): CliRunner {
  return (bin, args, opts = {}) =>
    new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let settled = false;
      const settle = (result: CliResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle({ code: CLI_TIMEOUT_CODE, stdout: out, stderr: `${err}\n[agent-reach: timed out after ${opts.timeoutMs ?? YTDLP_TIMEOUT_MS}ms]` });
      }, opts.timeoutMs ?? YTDLP_TIMEOUT_MS);
      child.stdout.on("data", (c: Buffer) => {
        if (out.length < CLI_MAX_OUTPUT_BYTES) out += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        if (err.length < CLI_MAX_OUTPUT_BYTES) err += c.toString("utf8");
      });
      // ENOENT (binary absent) arrives here, never as an exit code — without this
      // listener it is an uncaught exception that kills the gateway process.
      child.on("error", (e: NodeJS.ErrnoException) =>
        settle({ code: e.code === "ENOENT" ? CLI_ENOENT_CODE : 1, stdout: out, stderr: e.message }),
      );
      child.on("close", (code) => settle({ code: code ?? 1, stdout: out, stderr: err }));
    });
}

// ── VTT parsing (pure — the part most likely to break, so it is unit-tested) ──

/** WebVTT cue timing line: `00:00:01.000 --> 00:00:03.000 align:start position:0%`. */
const VTT_TIMING_RE = /-->/;
/** Inline karaoke spans yt-dlp leaves in auto-captions: `<00:00:01.234><c>word</c>`. */
const VTT_INLINE_TAG_RE = /<[^>]*>/g;

/**
 * WebVTT → plain prose.
 * Auto-generated captions repeat each line as a rolling two-line window, so
 * naive concatenation triples the text (and the token bill). Consecutive
 * duplicates are collapsed.
 */
export function vttToText(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("WEBVTT") || line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (line.startsWith("NOTE") || line.startsWith("STYLE")) continue;
    if (VTT_TIMING_RE.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // bare cue index
    const clean = line.replace(VTT_INLINE_TAG_RE, "").replace(/&nbsp;/g, " ").trim();
    if (!clean) continue;
    if (out.length > 0 && out[out.length - 1] === clean) continue; // rolling-window dupe
    out.push(clean);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** Accepts full URLs and bare 11-char IDs; rejects anything else so we never shell out on junk. */
export function normalizeYoutubeUrl(input: string): string | null {
  const raw = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return `https://www.youtube.com/watch?v=${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "youtu.be" || host === "youtube.com" || host === "m.youtube.com") return parsed.toString();
  return null;
}

// ── youtube_transcript ────────────────────────────────────────────────────────

export interface YoutubeTranscript {
  url: string;
  title: string;
  uploader?: string;
  duration_seconds?: number;
  transcript: string;
  truncated: boolean;
}

interface InfoJson {
  title?: string;
  uploader?: string;
  duration?: number;
}

/** Pick the best English VTT yt-dlp wrote (manual `.en.vtt` beats auto `.en-orig.vtt`). */
export function pickSubtitleFile(files: string[]): string | null {
  const vtts = files.filter((f) => f.endsWith(".vtt"));
  if (vtts.length === 0) return null;
  return (
    vtts.find((f) => /\.en\.vtt$/.test(f)) ??
    vtts.find((f) => /\.en[-.][A-Za-z]+\.vtt$/.test(f)) ??
    vtts.find((f) => /\.en/.test(f)) ??
    vtts[0]!
  );
}

export async function fetchYoutubeTranscript(
  rawUrl: string,
  run: CliRunner = makeCliRunner(),
): Promise<{ ok: true; data: YoutubeTranscript } | { ok: false; error: string }> {
  const url = normalizeYoutubeUrl(rawUrl);
  if (!url) return { ok: false, error: `Not a YouTube URL or video id: "${rawUrl}"` };

  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "fos-yt-"));
    const outDir = dir;
    const attempt = async (langs: string): Promise<CliResult> => {
      const args = [
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        langs,
        "--sub-format",
        "vtt",
        "--write-info-json",
        "--no-playlist",
        "--no-warnings",
        "-o",
        join(outDir, "%(id)s"),
        url,
      ];
      let out: CliResult = { code: CLI_ENOENT_CODE, stdout: "", stderr: "" };
      for (const bin of YTDLP_CANDIDATES) {
        if (!bin) continue;
        out = await run(bin, args, { timeoutMs: YTDLP_TIMEOUT_MS });
        if (out.code !== CLI_ENOENT_CODE) break;
      }
      return out;
    };

    let res = await attempt(SUB_LANGS_PRIMARY);
    if (res.code === CLI_ENOENT_CODE) {
      return {
        ok: false,
        error: "yt-dlp is not installed on this host. Install it with `pipx install yt-dlp` (component: yt-dlp).",
      };
    }
    if (res.code === CLI_TIMEOUT_CODE) {
      return { ok: false, error: `yt-dlp timed out after ${YTDLP_TIMEOUT_MS / 1000}s (component: yt-dlp).` };
    }

    let files = await readdir(dir);
    let subFile = pickSubtitleFile(files);
    if (!subFile) {
      // Foreign-language video: its only English track is auto-translated.
      res = await attempt(SUB_LANGS_TRANSLATED);
      files = await readdir(dir);
      subFile = pickSubtitleFile(files);
    }
    if (!subFile) {
      const detail = res.stderr.trim().split("\n").slice(-2).join(" ") || "no English captions published";
      return { ok: false, error: `No English captions available for ${url} — ${detail}` };
    }

    const vtt = await readFile(join(dir, subFile), "utf8");
    const full = vttToText(vtt);
    if (!full) return { ok: false, error: `Caption file for ${url} parsed to empty text (component: vtt-parse).` };

    const infoFile = files.find((f) => f.endsWith(".info.json"));
    let info: InfoJson = {};
    if (infoFile) {
      try {
        info = JSON.parse(await readFile(join(dir, infoFile), "utf8")) as InfoJson;
      } catch (err) {
        // allow-failopen: metadata is cosmetic; a malformed info.json must not
        // discard a transcript we already successfully extracted.
        log.warn({ err }, "youtube_transcript: info.json unreadable — continuing without metadata");
      }
    }

    const truncated = full.length > TRANSCRIPT_MAX_CHARS;
    return {
      ok: true,
      data: {
        url,
        title: info.title ?? "(title unavailable)",
        ...(info.uploader ? { uploader: info.uploader } : {}),
        ...(typeof info.duration === "number" ? { duration_seconds: Math.round(info.duration) } : {}),
        transcript: truncated ? `${full.slice(0, TRANSCRIPT_MAX_CHARS)}…` : full,
        truncated,
      },
    };
  } catch (err) {
    return { ok: false, error: `yt-dlp transcript failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (dir) {
      // allow-failopen: temp cleanup is best-effort; a failed rm must never turn an already-extracted transcript into a tool failure.
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// ── Jina Reader (keyless page read — wired as scrapeUrl's last-resort tier) ───

/**
 * Any URL → clean Markdown via Jina Reader. No key, no browser, works headless.
 * This is the fallback that runs when Apify has no token and a plain fetch is
 * blocked by the site.
 */
export async function readPageViaJina(
  url: string,
): Promise<{ ok: true; markdown: string; title: string } | { ok: false; error: string }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: "${url}"` };
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { ok: false, error: `Unsupported protocol "${target.protocol}" (component: jina-reader).` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);
  try {
    const res = await fetch(`${JINA_READER_BASE}${target.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) {
      return { ok: false, error: `Jina Reader returned HTTP ${res.status} for ${url} (component: jina-reader).` };
    }
    const body = (await res.text()).trim();
    if (!body) return { ok: false, error: `Jina Reader returned an empty body for ${url}.` };
    const titleMatch = /^Title:\s*(.+)$/m.exec(body);
    return { ok: true, markdown: body, title: titleMatch?.[1]?.trim() ?? target.hostname };
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? `timed out after ${JINA_TIMEOUT_MS / 1000}s` : String(err);
    return { ok: false, error: `Jina Reader failed for ${url}: ${reason} (component: jina-reader).` };
  } finally {
    clearTimeout(timer);
  }
}

// ── V2EX Topics (keyless public API) ──────────────────────────────────────────

export interface V2exTopic {
  id: number;
  title: string;
  url: string;
  content: string;
  replies: number;
  node: { name: string; title: string };
  member: { username: string };
  created: number;
}

export async function fetchV2exTopics(
  kind: "hot" | "node" = "hot",
  nodeName?: string,
): Promise<{ ok: true; data: V2exTopic[] } | { ok: false; error: string }> {
  let targetUrl = "https://www.v2ex.com/api/topics/hot.json";
  if (kind === "node" && nodeName) {
    targetUrl = `https://www.v2ex.com/api/topics/show.json?node_name=${encodeURIComponent(nodeName)}`;
  }
  try {
    const res = await fetch(targetUrl, {
      headers: { "User-Agent": "agent-reach/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, error: `V2EX API returned HTTP ${res.status}` };
    }
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) {
      return { ok: false, error: "V2EX API returned non-array payload" };
    }
    const topics: V2exTopic[] = json.map((item: Record<string, unknown>) => ({
      id: Number(item["id"] ?? 0),
      title: String(item["title"] ?? ""),
      url: String(item["url"] ?? ""),
      content: String(item["content"] ?? ""),
      replies: Number(item["replies"] ?? 0),
      node: {
        name: String((item["node"] as Record<string, unknown>)?.[ "name" ] ?? ""),
        title: String((item["node"] as Record<string, unknown>)?.[ "title" ] ?? ""),
      },
      member: {
        username: String((item["member"] as Record<string, unknown>)?.[ "username" ] ?? ""),
      },
      created: Number(item["created"] ?? 0),
    }));
    return { ok: true, data: topics };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── UnifiedTool ───────────────────────────────────────────────────────────────

export const agentReachTool: UnifiedTool = {
  name: "youtube_transcript",
  description:
    "Read the full spoken transcript of a YouTube video from its URL or video id. " +
    "Use to summarize, quote, or answer questions about a video's content. Read-only.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "YouTube URL or 11-character video id" },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = typeof args["url"] === "string" ? args["url"] : "";
    if (!url) return { success: false, error: "url is required" };
    const res = await fetchYoutubeTranscript(url);
    if (!res.ok) {
      log.warn({ url, error: res.error }, "youtube_transcript failed");
      return { success: false, error: res.error };
    }
    return { success: true, data: res.data };
  },
};
