/**
 * FounderOS — /context command parser and formatter
 * ===================================================
 * Pure functions for the /context Telegram command.
 *
 * Usage:
 *   /context            → show current founder context
 *   /context set <key> <value>  → update a single key
 *
 * Valid keys: active_clients, current_priorities, open_deals, next_actions, focus
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ContextAction =
  | { action: "show" }
  | { action: "set"; key: string; value: string }
  | { action: "error"; message: string };

const VALID_KEYS = new Set([
  "active_clients",
  "current_priorities",
  "open_deals",
  "next_actions",
  "focus",
]);

// ── Parser ────────────────────────────────────────────────────────────────────

/** Parse the argument string from /context into a typed action. */
export function parseContextCommand(arg: string): ContextAction {
  const trimmed = arg.trim();

  if (!trimmed || trimmed === "show") return { action: "show" };

  if (trimmed.startsWith("set")) {
    const rest = trimmed.slice(3).trim();
    if (!rest) {
      return { action: "error", message: "Usage: /context set <key> <value>\nValid keys: " + [...VALID_KEYS].join(", ") };
    }

    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) {
      return { action: "error", message: `Missing value. Usage: /context set ${rest} <value>` };
    }

    const key = rest.slice(0, spaceIdx).trim();
    const value = rest.slice(spaceIdx + 1).trim();

    if (!value) {
      return { action: "error", message: `Missing value. Usage: /context set ${key} <value>` };
    }

    return { action: "set", key, value };
  }

  return {
    action: "error",
    message: `Unknown subcommand. Usage:\n• /context — show context\n• /context set <key> <value> — update a key`,
  };
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/** Format the founder context object as a Telegram HTML message. */
export function formatContextDisplay(ctx: Record<string, unknown>): string {
  const entries = Object.entries(ctx).filter(([k]) => k !== "last_updated");

  if (entries.length === 0) {
    return (
      `📋 <b>Founder Context</b>\n\n` +
      `No context set yet. Use:\n` +
      `<code>/context set active_clients Acme Corp, Beta Ltd</code>\n` +
      `<code>/context set current_priorities Close Acme deal</code>`
    );
  }

  const lines = entries.map(([key, value]) => {
    const display = Array.isArray(value)
      ? (value as string[]).join(", ") || "none"
      : String(value || "none");
    return `• <b>${key}:</b> ${display}`;
  });

  const lastUpdated = ctx["last_updated"] as string | undefined;
  const footer = lastUpdated
    ? `\n\n<i>Last updated: ${lastUpdated.slice(0, 10)}</i>`
    : "";

  return `📋 <b>Founder Context</b>\n\n${lines.join("\n")}${footer}`;
}
