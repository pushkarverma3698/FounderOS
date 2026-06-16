/**
 * FounderOS — /signals and /runs pure formatters
 * ================================================
 * Deterministic Telegram HTML for pipeline visibility commands.
 * Handlers in commands.ts fetch data; these functions only format.
 */

import type { DeptSignal } from "../db/schema.js";

export const DEFAULT_RUNS_LIMIT = 10;
export const MAX_RUNS_LIMIT = 25;

export interface RecentLlmCall {
  agent: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: string;
  created_at: Date | null;
}

/** Parse optional limit from `/runs` or `/runs 15`. Clamps to [1, MAX_RUNS_LIMIT]. */
export function parseRunsLimit(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_RUNS_LIMIT;
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RUNS_LIMIT;
  return Math.min(n, MAX_RUNS_LIMIT);
}

function formatRelativeTime(when: Date | null): string {
  if (!when) return "unknown";
  const diffMins = Math.floor((Date.now() - when.getTime()) / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return `${Math.floor(diffMins / 1440)}d ago`;
}

function formatSignalLine(signal: DeptSignal): string {
  const p = (signal.payload ?? {}) as {
    company?: string;
    icpScore?: number;
    contactName?: string;
    source?: string;
  };
  const company = p.company ?? signal.event_type;
  const score = typeof p.icpScore === "number" ? ` · ICP ${p.icpScore}` : "";
  const src = p.source ? ` · via ${p.source}` : "";
  const who = p.contactName ? ` (${p.contactName})` : "";
  return (
    `• <code>${signal.event_type}</code> → ${signal.to_dept}: ` +
    `<b>${company}</b>${who}${score}${src} · ${formatRelativeTime(signal.created_at)}`
  );
}

/** Format pending dept_signals for /signals (read-only — does not consume). */
export function formatSignalsMessage(signals: DeptSignal[]): string {
  if (signals.length === 0) {
    return (
      `📡 <b>Pipeline signals</b>\n\n` +
      `No pending signals. Leads from <code>/outbound</code> (ICP 8–10) appear here until the hourly sweep surfaces them.`
    );
  }
  const lines = signals.map(formatSignalLine);
  return (
    `📡 <b>Pipeline signals</b> (${signals.length} pending)\n\n` +
    `${lines.join("\n")}\n\n` +
    `Next: <code>/q sales draft cold outreach to {company}</code> — you approve before anything sends.`
  );
}

/** Format recent LLM calls + today's spend for /runs. */
export function formatRunsMessage(todayUsd: number, calls: RecentLlmCall[]): string {
  const todayLine = `💰 Today: <b>$${todayUsd.toFixed(4)}</b>`;
  if (calls.length === 0) {
    return `📊 <b>Recent runs</b>\n\n${todayLine}\n\nNo LLM calls logged yet.`;
  }
  const lines = calls.map((c) => {
    const usd = parseFloat(c.cost_usd);
    const cost = Number.isFinite(usd) ? `$${usd.toFixed(4)}` : c.cost_usd;
    const tok = c.tokens_in + c.tokens_out;
    return (
      `• ${formatRelativeTime(c.created_at)} · <code>${c.agent}</code> · ` +
      `${tok.toLocaleString()} tok · ${cost}`
    );
  });
  return (
    `📊 <b>Recent runs</b> (last ${calls.length})\n\n` +
    `${todayLine}\n\n` +
    `${lines.join("\n")}`
  );
}
