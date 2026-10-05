/**
 * The trail of every /login event: who signed in, signed out or was removed, when, and whether it worked.
 * One `action_log` row per event (action `login_event`), written after the event happened, never before.
 * A row names the tool and target and one short plain-text reason. It never holds a code, token or link.
 */

export const LOGIN_EVENT_ACTION = "login_event";

export type LoginEventKind = "login" | "logout" | "remove";

export interface LoginEvent {
  readonly tool: string;
  readonly target: string;
  readonly kind: LoginEventKind;
  readonly ok: boolean;
  /** Telegram HTML or plain text; stored as short plain text. */
  readonly detail?: string;
}

export interface LoginEventRow extends LoginEvent {
  readonly at: Date;
}

export interface LoginAudit {
  record(event: LoginEvent): Promise<void>;
  /** Newest first. */
  recent(limit: number): Promise<readonly LoginEventRow[]>;
}

/** Tags and entities out, whitespace collapsed, capped: what is safe and useful in an audit row. */
export function plainDetail(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 200) : undefined;
}

const WORD: Record<LoginEventKind, readonly [string, string]> = {
  login: ["signed in", "sign-in failed"],
  logout: ["signed out", "sign-out failed"],
  remove: ["removed", "remove failed"],
};

const stamp = (d: Date): string => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

/** `/login history`: the newest events, one line each. */
export function historyText(rows: readonly LoginEventRow[]): string {
  if (rows.length === 0) return "No login or logout has been recorded yet.";
  const esc = (s: string): string => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
  const lines = rows.map((r) => {
    const [good, bad] = WORD[r.kind];
    const target = r.target === "default" ? "" : ` ${esc(r.target)}`;
    return `${r.ok ? "✅" : "❌"} ${stamp(r.at)} — ${esc(r.tool)}${target}: ${r.ok ? good : bad}${!r.ok && r.detail ? ` (${esc(r.detail)})` : ""}`;
  });
  return `<b>Recent login events</b>\n${lines.join("\n")}`;
}
