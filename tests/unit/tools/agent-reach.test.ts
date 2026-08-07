/**
 * Unit tests for the agent-reach tool (youtube_transcript + Jina Reader tier).
 * =============================================================================
 * The yt-dlp runner is an injected fake that writes the same files the real
 * binary writes, and `fetch` is stubbed — $0, no network, no binaries required.
 *
 * Pins the contracts that actually break:
 *   - VTT parsing: auto-captions arrive as a rolling window and TRIPLE the text
 *     (and the token bill) if consecutive duplicates are not collapsed.
 *   - A missing binary is a typed failure naming yt-dlp, never a thrown crash.
 *   - Transcripts are bounded so a 3h stream cannot eat the turn budget.
 *   - URL normalisation rejects non-YouTube hosts before we ever shell out.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  vttToText,
  normalizeYoutubeUrl,
  pickSubtitleFile,
  fetchYoutubeTranscript,
  readPageViaJina,
  agentReachTool,
  TRANSCRIPT_MAX_CHARS,
  SUB_LANGS_PRIMARY,
  SUB_LANGS_TRANSLATED,
  CLI_ENOENT_CODE,
  CLI_TIMEOUT_CODE,
  type CliRunner,
  type CliResult,
} from "../../../src/tools/agent-reach.js";

// ── Test doubles ──────────────────────────────────────────────────────────────

/** Locates the `-o <dir>/%(id)s` argument the tool passes and returns the dir. */
function outputDir(args: string[]): string {
  const i = args.indexOf("-o");
  if (i === -1 || !args[i + 1]) throw new Error("test fake: no -o argument found");
  return dirname(args[i + 1]!);
}

/** Fake yt-dlp: writes the files the real binary would, then exits 0. */
function fakeYtDlp(files: Record<string, string>, calls: string[][] = []): { run: CliRunner; calls: string[][] } {
  const run: CliRunner = async (_bin, args) => {
    calls.push(args);
    const dir = outputDir(args);
    for (const [name, body] of Object.entries(files)) {
      await writeFile(`${dir}/${name}`, body, "utf8");
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const constRunner = (result: CliResult): CliRunner => async () => result;

const INFO_JSON = JSON.stringify({ title: "Deterministic Agents", uploader: "FounderOS", duration: 754 });

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── vttToText ─────────────────────────────────────────────────────────────────

describe("vttToText", () => {
  it("strips the WEBVTT header, cue indices, timings, and inline karaoke tags", () => {
    // Arrange
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "1",
      "00:00:01.000 --> 00:00:03.000 align:start position:0%",
      "hello <00:00:01.500><c>world</c>",
      "",
    ].join("\n");

    // Act
    const text = vttToText(vtt);

    // Assert
    expect(text).toBe("hello world");
  });

  it("collapses the rolling-window duplicates auto-captions emit", () => {
    // Arrange — this is exactly how YouTube auto-captions repeat each line.
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "the kernel is deterministic",
      "",
      "00:00:03.000 --> 00:00:05.000",
      "the kernel is deterministic",
      "",
      "00:00:05.000 --> 00:00:07.000",
      "and every boundary is validated",
      "",
    ].join("\n");

    // Act
    const text = vttToText(vtt);

    // Assert
    expect(text).toBe("the kernel is deterministic and every boundary is validated");
  });

  it("returns empty string when the cue body is only timings", () => {
    expect(vttToText("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n")).toBe("");
  });
});

// ── normalizeYoutubeUrl ───────────────────────────────────────────────────────

describe("normalizeYoutubeUrl", () => {
  it("expands a bare 11-character video id", () => {
    expect(normalizeYoutubeUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
  ])("accepts %s", (url) => {
    expect(normalizeYoutubeUrl(url)).toBeTruthy();
  });

  it.each([
    ["a non-YouTube host", "https://vimeo.com/12345"],
    ["a lookalike host", "https://youtube.com.evil.test/watch?v=x"],
    ["a non-http protocol", "file:///etc/passwd"],
    ["free text", "summarize that video for me"],
  ])("rejects %s", (_label, input) => {
    expect(normalizeYoutubeUrl(input)).toBeNull();
  });
});

// ── pickSubtitleFile ──────────────────────────────────────────────────────────

describe("pickSubtitleFile", () => {
  it("prefers the manual .en.vtt over auto-generated variants", () => {
    expect(pickSubtitleFile(["v.en-orig.vtt", "v.en.vtt", "v.info.json"])).toBe("v.en.vtt");
  });

  it("falls back to an auto-generated English track", () => {
    expect(pickSubtitleFile(["v.en-orig.vtt", "v.info.json"])).toBe("v.en-orig.vtt");
  });

  it("returns null when no vtt was written", () => {
    expect(pickSubtitleFile(["v.info.json"])).toBeNull();
  });
});

// ── fetchYoutubeTranscript ────────────────────────────────────────────────────

describe("fetchYoutubeTranscript", () => {
  it("returns transcript text plus metadata on the happy path", async () => {
    // Arrange
    const { run } = fakeYtDlp({
      "vid.en.vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\ncontracts are the architecture\n",
      "vid.info.json": INFO_JSON,
    });

    // Act
    const res = await fetchYoutubeTranscript("dQw4w9WgXcQ", run);

    // Assert
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.transcript).toBe("contracts are the architecture");
    expect(res.data.title).toBe("Deterministic Agents");
    expect(res.data.uploader).toBe("FounderOS");
    expect(res.data.duration_seconds).toBe(754);
    expect(res.data.truncated).toBe(false);
  });

  it("survives a malformed info.json rather than discarding the transcript", async () => {
    // Arrange
    const { run } = fakeYtDlp({
      "vid.en.vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nstill useful\n",
      "vid.info.json": "{ this is not json",
    });

    // Act
    const res = await fetchYoutubeTranscript("dQw4w9WgXcQ", run);

    // Assert
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.transcript).toBe("still useful");
    expect(res.data.title).toBe("(title unavailable)");
  });

  it("truncates a transcript that would blow the turn budget", async () => {
    // Arrange — 40k unique chars of caption body.
    const long = Array.from({ length: 4_000 }, (_, i) => `word${i}`).join(" ");
    const { run } = fakeYtDlp({
      "vid.en.vtt": `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${long}\n`,
      "vid.info.json": INFO_JSON,
    });

    // Act
    const res = await fetchYoutubeTranscript("dQw4w9WgXcQ", run);

    // Assert
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.truncated).toBe(true);
    expect(res.data.transcript.length).toBe(TRANSCRIPT_MAX_CHARS + 1); // + the ellipsis
  });

  it("names yt-dlp when the binary is not installed", async () => {
    // Arrange
    const run = constRunner({ code: CLI_ENOENT_CODE, stdout: "", stderr: "" });

    // Act
    const res = await fetchYoutubeTranscript("dQw4w9WgXcQ", run);

    // Assert
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/yt-dlp is not installed/);
    expect(res.error).toMatch(/pipx install yt-dlp/);
  });

  it("reports a timeout as a timeout, not as missing captions", async () => {
    // Arrange
    const run = constRunner({ code: CLI_TIMEOUT_CODE, stdout: "", stderr: "" });

    // Act
    const res = await fetchYoutubeTranscript("dQw4w9WgXcQ", run);

    // Assert
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/timed out/);
  });

  it("reports a clear error when the video has no English captions", async () => {
    // Arrange — yt-dlp exits 0 but writes only metadata.
    const { run } = fakeYtDlp({ "vid.info.json": INFO_JSON });

    // Act
    const res = await fetchYoutubeTranscript("dQw4w9WgXcQ", run);

    // Assert
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/No English captions/);
  });

  it("asks for a NARROW native-English lang list on the first attempt", async () => {
    // Regression (live-verified 2026-08-07): a broad `en.*` glob matches the
    // hundreds of auto-translated tracks YouTube publishes. yt-dlp downloads
    // every one, earns HTTP 429 partway through, and aborts BEFORE writing
    // info.json — which is exactly how metadata silently came back empty.
    // Arrange
    const calls: string[][] = [];
    const { run } = fakeYtDlp({ "vid.en.vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n" }, calls);

    // Act
    await fetchYoutubeTranscript("dQw4w9WgXcQ", run);

    // Assert
    const langs = calls[0]![calls[0]!.indexOf("--sub-langs") + 1];
    expect(langs).toBe(SUB_LANGS_PRIMARY);
    expect(langs).not.toContain("en.*");
    expect(calls).toHaveLength(1); // primary succeeded — no wasteful second run
  });

  it("retries with translated tracks when the native-English attempt finds nothing", async () => {
    // Arrange — first call writes nothing, second writes an auto-translated track.
    const calls: string[][] = [];
    const run: CliRunner = async (_bin, args) => {
      calls.push(args);
      if (calls.length === 2) {
        await writeFile(`${outputDir(args)}/vid.en-de.vtt`, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\ntranslated\n", "utf8");
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    // Act
    const res = await fetchYoutubeTranscript("dQw4w9WgXcQ", run);

    // Assert
    expect(calls).toHaveLength(2);
    expect(calls[1]![calls[1]!.indexOf("--sub-langs") + 1]).toBe(SUB_LANGS_TRANSLATED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.transcript).toBe("translated");
  });

  it("rejects a non-YouTube URL without shelling out at all", async () => {
    // Arrange
    const calls: string[][] = [];
    const { run } = fakeYtDlp({}, calls);

    // Act
    const res = await fetchYoutubeTranscript("https://vimeo.com/12345", run);

    // Assert
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ── readPageViaJina ───────────────────────────────────────────────────────────

describe("readPageViaJina", () => {
  it("returns markdown and parses the Title header", async () => {
    // Arrange
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Title: Example Domain\n\nBody text here.", { status: 200 })),
    );

    // Act
    const res = await readPageViaJina("https://example.com");

    // Assert
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.title).toBe("Example Domain");
    expect(res.markdown).toContain("Body text here.");
  });

  it("calls the Jina reader prefix rather than the raw site", async () => {
    // Arrange
    const spy = vi.fn(async (_url: string) => new Response("Title: X\n\nbody", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    // Act
    await readPageViaJina("https://example.com/pricing");

    // Assert
    expect(spy.mock.calls[0]?.[0]).toBe("https://r.jina.ai/https://example.com/pricing");
  });

  it("names jina-reader on a non-200", async () => {
    // Arrange
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));

    // Act
    const res = await readPageViaJina("https://example.com");

    // Assert
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/HTTP 502/);
    expect(res.error).toMatch(/jina-reader/);
  });

  it("fails soft on an empty body", async () => {
    // Arrange
    vi.stubGlobal("fetch", vi.fn(async () => new Response("   ", { status: 200 })));

    // Act
    const res = await readPageViaJina("https://example.com");

    // Assert
    expect(res.ok).toBe(false);
  });

  it.each([
    ["an invalid URL", "not a url"],
    ["a file: URL", "file:///etc/passwd"],
  ])("rejects %s without fetching", async (_label, url) => {
    // Arrange
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    // Act
    const res = await readPageViaJina(url);

    // Assert
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── UnifiedTool envelope ──────────────────────────────────────────────────────

describe("agentReachTool (UnifiedTool contract)", () => {
  it("declares youtube_transcript with a required url", () => {
    expect(agentReachTool.name).toBe("youtube_transcript");
    expect(agentReachTool.input_schema?.required).toContain("url");
  });

  it("returns a failed ToolResult (never throws) when url is missing", async () => {
    // Act
    const res = await agentReachTool.execute({});

    // Assert
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/url is required/);
  });

  it("returns a failed ToolResult (never throws) for a non-YouTube url", async () => {
    // Act
    const res = await agentReachTool.execute({ url: "https://vimeo.com/1" });

    // Assert
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Not a YouTube URL/);
  });
});
