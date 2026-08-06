/**
 * Unit test for Telegram Voice Gateway flow (src/gateway/media.ts handleVoice).
 * Simulates a Telegram voice message input, converts OGG->WAV, transcribes audio,
 * replies with "Heard: ...", and routes to runOfficeText with HITL intact.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../../../src/infra/media-convert.js", () => ({
  checkFfmpeg: vi.fn().mockResolvedValue(true),
  oggToWav: vi.fn().mockResolvedValue(Buffer.from("mock_wav_bytes")),
}));

vi.mock("../../../src/tools/transcription.js", () => ({
  transcribeAudio: vi.fn().mockResolvedValue({
    success: true,
    data: {
      hasSpeech: true,
      detectedLanguage: "English",
      transcript: "Schedule a team sync tomorrow at 10am",
      englishText: "Schedule a team sync tomorrow at 10am",
    },
  }),
}));

import { registerMediaHandlers } from "../../../src/gateway/media.js";
import { checkFfmpeg, oggToWav } from "../../../src/infra/media-convert.js";
import { transcribeAudio } from "../../../src/tools/transcription.js";

describe("Telegram Voice Command End-to-End Pipeline", () => {
  let handlers: Record<string, Function> = {};

  const mockBot = {
    on: vi.fn().mockImplementation((event: string | string[], handler: Function) => {
      const keys = Array.isArray(event) ? event : [event];
      for (const k of keys) handlers[k] = handler;
    }),
  } as any;

  const mockRunOfficeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};
    registerMediaHandlers(mockBot, mockRunOfficeText);
  });

  it("registers message:voice handler", () => {
    expect(handlers["message:voice"]).toBeDefined();
    expect(handlers["message:audio"]).toBeDefined();
  });

  it("processes voice note: downloads file, converts OGG->WAV, transcribes, replies and routes to kernel", async () => {
    const mockCtx = {
      from: { id: 12345 },
      message: {
        voice: { file_id: "voice_file_999", duration: 5 },
      },
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: "voice/file.ogg", file_size: 1024 }),
      },
      replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    } as any);

    try {
      const voiceHandler = handlers["message:voice"];
      expect(voiceHandler).toBeDefined();
      await voiceHandler!(mockCtx);

      expect(mockCtx.replyWithChatAction).toHaveBeenCalledWith("typing");
      expect(checkFfmpeg).toHaveBeenCalled();
      expect(oggToWav).toHaveBeenCalled();
      expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), "audio/wav");

      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining("Heard (English):"),
        { parse_mode: "HTML" }
      );

      expect(mockRunOfficeText).toHaveBeenCalledWith(
        mockCtx,
        "Schedule a team sync tomorrow at 10am"
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles voice note with no speech gracefully", async () => {
    vi.mocked(transcribeAudio).mockResolvedValueOnce({
      success: true,
      data: {
        hasSpeech: false,
        detectedLanguage: "",
        transcript: "",
        englishText: "",
      },
    });

    const mockCtx = {
      from: { id: 12345 },
      message: { voice: { file_id: "silent_voice_123", duration: 2 } },
      api: { getFile: vi.fn().mockResolvedValue({ file_path: "silent.ogg", file_size: 512 }) },
      replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    } as any);

    try {
      const voiceHandler = handlers["message:voice"];
      expect(voiceHandler).toBeDefined();
      await voiceHandler!(mockCtx);
      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining("couldn't make out any speech")
      );
      expect(mockRunOfficeText).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
