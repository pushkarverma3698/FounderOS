/**
 * FounderOS — Telegram Media Gateway
 * ===================================
 * Feature A — Image translation: photo (or image document) → Gemini vision →
 *   English translation as text (+ optional TTS voice note when the caption
 *   asks to "speak"/"read it").
 * Feature B — Voice command: voice/audio → ffmpeg OGG/Opus→WAV → Gemini
 *   transcription (+ language detection) → translate to English if needed →
 *   inject the ENGLISH text into the normal office pipeline (supervisor →
 *   department → tools → HITL). Voice is just an input method — it must never
 *   bypass HITL or any security guard.
 *
 * Every download/convert/model call is wrapped: failures become clear human
 * replies, never a crash or silence.
 */

import { InputFile, type Bot, type Context } from "grammy";
import { env } from "../core/config.js";
import { childLogger } from "../infra/logger.js";
import { checkFfmpeg, oggToWav } from "../infra/media-convert.js";
import { translateImage } from "../tools/vision.js";
import { transcribeAudio } from "../tools/transcription.js";
import { synthesizeSpeech } from "../tools/tts.js";
import { safeHtml } from "./telegram.js";

const log = childLogger({ module: "media" });

/** Max media size we'll download (Telegram bot API caps downloads at 20MB anyway). */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export type RunOfficeTextFn = (ctx: Context, text: string) => Promise<void>;

// ── Download ──────────────────────────────────────────────────────────────────

/** Download a Telegram file by file_id via getFile → file endpoint. */
async function downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file_path");
  if ((file.file_size ?? 0) > MAX_MEDIA_BYTES) throw new Error("File too large (>20MB)");
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`File download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Feature A — image translation ─────────────────────────────────────────────

/** Does the caption ask for a spoken reply? Exported for unit tests. */
export function wantsSpeech(caption: string): boolean {
  return /\b(speak|spoken|say it|read it|read aloud|aloud|voice|voice note|uitspreken|voorlezen)\b/i.test(caption);
}

/** Friendly acknowledgement for content types the bot can't process — prevents silent drops. Exported for tests. */
export function unsupportedMediaReply(label: string): string {
  return `🤔 I can't handle ${label} yet — I work with text, voice notes, and photos of text. Send your request as a message and I'll get on it.`;
}

async function handleUnsupported(ctx: Context, label: string): Promise<void> {
  log.info({ from: ctx.from?.id, kind: label }, "Unsupported media received — acknowledging instead of dropping");
  await ctx.reply(unsupportedMediaReply(label)).catch(() => {});
}

async function handleImage(ctx: Context, fileId: string, mimeType: string): Promise<void> {
  const caption = ctx.message?.caption ?? "";
  await ctx.replyWithChatAction("typing").catch(() => {});

  let bytes: Buffer;
  try {
    bytes = await downloadTelegramFile(ctx, fileId);
  } catch (err) {
    log.error({ err: (err as Error).message }, "Image download failed");
    await ctx.reply("❌ I couldn't download that image from Telegram — please try sending it again.");
    return;
  }

  const result = await translateImage(bytes, mimeType);
  if (!result.success) {
    await ctx.reply("❌ I couldn't read that image — try a sharper, well-lit photo.");
    return;
  }

  const t = result.data;
  if (!t.hasText || !t.englishText.trim()) {
    await ctx.reply("🔍 I couldn't find any readable text in that image. Try a clearer photo of the text.");
    return;
  }

  const isEnglish = /^english$/i.test(t.sourceLanguage.trim());
  const header = isEnglish
    ? "🇬🇧 <b>This text is already in English:</b>"
    : `🌐 <b>${safeHtml(t.sourceLanguage)} → English</b>`;
  const body = isEnglish
    ? safeHtml(t.englishText)
    : `${safeHtml(t.englishText)}\n\n<i>Original (${safeHtml(t.sourceLanguage)}):</i>\n<i>${safeHtml(t.originalText.slice(0, 1000))}</i>`;
  await ctx.reply(`${header}\n\n${body}`.slice(0, 4000), { parse_mode: "HTML" });

  if (wantsSpeech(caption)) {
    await ctx.replyWithChatAction("record_voice").catch(() => {});
    const tts = await synthesizeSpeech(t.englishText);
    if (tts.success) {
      await ctx.replyWithVoice(new InputFile(tts.data.oggOpus, "translation.ogg"));
    } else {
      log.warn({ err: tts.error }, "TTS failed — text reply already sent");
      await ctx.reply("⚠️ Couldn't generate the voice note (text translation above still stands).");
    }
  }
}

// ── Feature B — voice command ─────────────────────────────────────────────────

async function handleVoice(ctx: Context, fileId: string, runOfficeText: RunOfficeTextFn): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => {});

  if (!(await checkFfmpeg())) {
    await ctx.reply("⚠️ Voice processing is unavailable on this machine (ffmpeg missing). Please type your message instead.");
    return;
  }

  // 1. Download OGG/Opus
  let ogg: Buffer;
  try {
    ogg = await downloadTelegramFile(ctx, fileId);
  } catch (err) {
    log.error({ err: (err as Error).message }, "Voice download failed");
    await ctx.reply("❌ I couldn't download that voice note — please try again.");
    return;
  }

  // 2. Convert OGG/Opus → WAV (Gemini-supported)
  let wav: Buffer;
  try {
    wav = await oggToWav(ogg);
  } catch (err) {
    log.error({ err: (err as Error).message }, "OGG→WAV conversion failed");
    await ctx.reply("❌ I couldn't process that audio format — please try recording again.");
    return;
  }

  // 3. Transcribe + detect language + translate (strict order, inside the tool)
  const result = await transcribeAudio(wav, "audio/wav");
  if (!result.success) {
    await ctx.reply("❌ I couldn't transcribe that — please try again or type your message.");
    return;
  }

  const t = result.data;
  if (!t.hasSpeech) {
    log.info("Voice note had no intelligible speech — refusing to act");
    await ctx.reply("🎙 I couldn't make out any speech in that recording — please try again.");
    return;
  }

  const isEnglish = /^english$/i.test(t.detectedLanguage.trim());
  const englishCommand = isEnglish ? t.transcript : t.englishText;
  log.info(
    { detectedLanguage: t.detectedLanguage, isEnglish, transcript: t.transcript.slice(0, 120), english: englishCommand.slice(0, 120) },
    "Voice command transcribed — injecting English text into office pipeline",
  );

  // 4. Confirm what was heard, then run through the NORMAL pipeline (HITL intact).
  const heard = isEnglish
    ? `🎙 <b>Heard (English):</b> <i>${safeHtml(t.transcript.slice(0, 500))}</i> — working on it…`
    : `🎙 <b>Heard (${safeHtml(t.detectedLanguage)} → English):</b> <i>${safeHtml(englishCommand.slice(0, 500))}</i> — working on it…`;
  await ctx.reply(heard, { parse_mode: "HTML" });

  await runOfficeText(ctx, englishCommand);
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerMediaHandlers(bot: Bot, runOfficeText: RunOfficeTextFn): void {
  bot.on("message:photo", async (ctx: Context) => {
    // message.photo is an ARRAY of sizes — always take the LAST (largest) for OCR.
    const sizes = ctx.message?.photo ?? [];
    const largest = sizes[sizes.length - 1];
    if (!largest) return;
    log.info({ from: ctx.from?.id, sizes: sizes.length, caption: ctx.message?.caption ?? "" }, "Photo received");
    await handleImage(ctx, largest.file_id, "image/jpeg");
  });

  bot.on("message:document", async (ctx: Context) => {
    const doc = ctx.message?.document;
    if (!doc) return;
    if (!doc.mime_type?.startsWith("image/")) {
      await handleUnsupported(ctx, "non-image files"); // was a silent drop
      return;
    }
    log.info({ from: ctx.from?.id, mime: doc.mime_type }, "Image document received");
    await handleImage(ctx, doc.file_id, doc.mime_type);
  });

  bot.on("message:voice", async (ctx: Context) => {
    const voice = ctx.message?.voice;
    if (!voice) return;
    log.info({ from: ctx.from?.id, duration: voice.duration }, "Voice message received");
    await handleVoice(ctx, voice.file_id, runOfficeText);
  });

  bot.on("message:audio", async (ctx: Context) => {
    const audio = ctx.message?.audio;
    if (!audio) return;
    log.info({ from: ctx.from?.id, duration: audio.duration }, "Audio message received");
    await handleVoice(ctx, audio.file_id, runOfficeText);
  });

  // Content types we can't process yet: acknowledge instead of dropping silently.
  bot.on(["message:video", "message:video_note"], (ctx: Context) => handleUnsupported(ctx, "videos"));
  bot.on(["message:sticker", "message:animation"], (ctx: Context) => handleUnsupported(ctx, "stickers or GIFs"));
  bot.on("message:location", (ctx: Context) => handleUnsupported(ctx, "locations"));
  bot.on("message:contact", (ctx: Context) => handleUnsupported(ctx, "contacts"));
}
