/**
 * FounderOS — Gateway Session (transport-neutral)
 * ================================================
 * Abstracts Telegram vs web I/O so office-run.ts stays UI-agnostic (ADR-007).
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { ApprovalRequest } from "../agents/agent-tools.js";
import { TENANT } from "../core/config.js";
import { logger } from "../infra/logger.js";
import { markdownToTelegramHtml, splitForTelegram, TELEGRAM_MAX } from "./format.js";
import { formatApprovalCard } from "./approval-card.js";
import { publishStreamEvent } from "./stream-hub.js";

const log = logger.child({ module: "gateway-session" });

export interface GatewaySession {
  readonly id: string;
  readonly threadId: string;
  readonly transport: "telegram" | "web";
  onTyping(): () => void;
  onStatus(text: string): Promise<void>;
  onReply(markdown: string): Promise<void>;
  onHtml(html: string): Promise<void>;
  onSystemNotice(html: string): Promise<void>;
  onApproval(approval: ApprovalRequest): Promise<void>;
  emitStream(type: Parameters<typeof publishStreamEvent>[1]["type"], data?: Record<string, unknown>): void;
}

export function threadIdForSession(sessionId: string | number): string {
  return `${TENANT}:${sessionId}`;
}

function noopTyping(): () => void {
  return () => {};
}

/** grammy Context → GatewaySession adapter. */
export function createTelegramSession(ctx: Context): GatewaySession {
  const id = String(ctx.chat?.id ?? ctx.from?.id ?? "unknown");
  const threadId = threadIdForSession(id);

  async function sendHtmlSafe(html: string): Promise<void> {
    try {
      await ctx.reply(html, { parse_mode: "HTML" });
    } catch (err) {
      log.warn({ err: (err as Error).message }, "HTML send failed — plain text fallback");
      await ctx.reply(html.replace(/<[^>]+>/g, ""));
    }
  }

  return {
    id,
    threadId,
    transport: "telegram",
    onTyping() {
      ctx.replyWithChatAction("typing").catch(() => {});
      const timer = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
      return () => clearInterval(timer);
    },
    async onStatus(text) {
      await ctx.reply(text.slice(0, 4000));
    },
    async onReply(markdown) {
      const html = markdownToTelegramHtml(markdown);
      for (const chunk of splitForTelegram(html, TELEGRAM_MAX)) {
        await sendHtmlSafe(chunk);
      }
    },
    onHtml: sendHtmlSafe,
    onSystemNotice: sendHtmlSafe,
    async onApproval(approval) {
      const { html, keyboard } = formatApprovalCard(approval);
      await ctx.reply(html, { parse_mode: "HTML", reply_markup: keyboard });
      publishStreamEvent(id, {
        type: "hitl.pending",
        data: { title: approval.title, summary: approval.summary, preview: approval.preview?.slice(0, 500) },
      });
    },
    emitStream(type, data) {
      publishStreamEvent(id, { type, data });
    },
  };
}

/** Web client session — replies via SSE; no Telegram I/O. */
export function createWebSession(sessionId: string): GatewaySession {
  const threadId = threadIdForSession(sessionId);

  return {
    id: sessionId,
    threadId,
    transport: "web",
    onTyping: noopTyping,
    async onStatus(text) {
      publishStreamEvent(sessionId, { type: "tool.start", data: { status: text } });
    },
    async onReply(markdown) {
      publishStreamEvent(sessionId, { type: "turn.complete", data: { reply: markdown } });
    },
    async onHtml(html) {
      publishStreamEvent(sessionId, { type: "turn.complete", data: { replyHtml: html } });
    },
    onSystemNotice: async (html) => {
      const plain = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      publishStreamEvent(sessionId, {
        type: "turn.error",
        data: { message: plain, notice: true },
      });
    },
    async onApproval(approval) {
      publishStreamEvent(sessionId, {
        type: "hitl.pending",
        data: {
          title: approval.title,
          summary: approval.summary,
          preview: approval.preview?.slice(0, 2000),
          action: approval.action,
        },
      });
    },
    emitStream(type, data) {
      publishStreamEvent(sessionId, { type, data });
    },
  };
}

/** Build inline keyboard for web HITL (exported for tests). */
export function buildApprovalKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ Approve", "approve").text("❌ Reject", "reject");
}
