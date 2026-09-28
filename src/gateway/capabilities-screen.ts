/**
 * FounderOS — "🧭 Everything I can do"
 * ====================================
 * Every tool every team carries, in words, from the live registry.
 *
 * The founder, 2026-09-28: "make sure that all the features and commands are
 * already there so that we can see all the capabilities we already have."
 * The truth already existed — buildCapabilityManifest() renders DEPARTMENT_TOOLS
 * — but only into the supervisor's prompt. This is the same registry, for him.
 *
 * NOTHING HERE IS A HAND-WRITTEN CLAIM (capabilities.ts: "never hand-edit
 * capability claims"). Which tools exist, which team has them, which ask first
 * (HITL_GATED_TOOLS) and which the server has not set up (kernel-boot.ts
 * isUnconfiguredTool) all come from code; what each one does is the first
 * sentence of the tool's OWN description, the text the worker model reads. A
 * tool added to a department, or bridged in over MCP, shows up here unasked.
 * The only prose in this file names the teams and turns ids into words.
 *
 * Split across messages, packed by team, because the whole list is ~85 rows and
 * Telegram caps a message at 4,096 characters. A team too big for one message
 * continues in the next. No row is ever dropped.
 */

import type { Context } from "grammy";
import type { WorkerId } from "../kernel/contracts.js";
import { esc } from "../tools/jobhunt/telegram-format.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "capabilities-screen" });

/** Handled by home-menu.ts before its section parser: this "section" is several messages, not one edit. */
export const CAPABILITIES_CALLBACK = "menu:can";

/** Team names for people. Typed by WorkerId, so a new worker without a name does not compile. */
export const DEPARTMENT_LABELS: Readonly<Record<WorkerId, { emoji: string; label: string }>> = {
  admin: { emoji: "🧠", label: "Admin" },
  research: { emoji: "🔍", label: "Research" },
  comms: { emoji: "📨", label: "Comms" },
  engineering: { emoji: "⚙️", label: "Engineering" },
  marketing: { emoji: "📣", label: "Marketing" },
  sales: { emoji: "📈", label: "Sales" },
  personal: { emoji: "💻", label: "Personal" },
  jobhunt: { emoji: "🎯", label: "Jobs" },
};

export interface CapabilityRegistry {
  readonly departments: Readonly<Record<string, ReadonlyArray<{ name: string; description?: string }>>>;
  /** HITL_GATED_TOOLS: the founder approves before these act. */
  readonly gated: ReadonlySet<string>;
  /** False for a registered tool the running server withholds (not configured). */
  readonly isAvailable: (toolName: string) => boolean;
}

/** Headroom under Telegram's 4,096 for the HTML the packer adds between blocks. */
const MESSAGE_BUDGET = 3_800;
const SENTENCE_MAX = 200;

/** "e.g." and friends end in a full stop without ending the sentence. */
const ABBREVIATION = /(?:\be\.g|\bi\.e|\betc|\bvs|\bapprox)\.$/i;

/** The first sentence of a tool's own description, capped rather than dropped when long. */
export function firstSentence(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  let sentence = text;
  for (const m of text.matchAll(/[.!?](?=\s|$)/g)) {
    const upTo = text.slice(0, (m.index ?? 0) + 1);
    if (ABBREVIATION.test(upTo)) continue;
    sentence = upTo;
    break;
  }
  return sentence.length > SENTENCE_MAX ? `${sentence.slice(0, SENTENCE_MAX - 1).trimEnd()}…` : sentence;
}

const SPELLED: Readonly<Record<string, string>> = {
  ai: "AI",
  antigravity: "Antigravity",
  api: "API",
  csv: "CSV",
  cv: "CV",
  github: "GitHub",
  linkedin: "LinkedIn",
  mcp: "MCP",
  rag: "RAG",
  turicks: "Turicks",
  ui: "UI",
  url: "URL",
  v2ex: "V2EX",
  vps: "VPS",
  youtube: "YouTube",
};

function spell(id: string): string {
  const words = id.split(/[_\-\s]+/).filter(Boolean).map((w) => SPELLED[w.toLowerCase()] ?? w.toLowerCase());
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `send_email` → "Send email"; a bridged `mcp__github__create_issue` → "GitHub: create issue". */
export function toolLabel(name: string): string {
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    const action = spell(rest.join(" "));
    return `${spell(server)}: ${action.charAt(0).toLowerCase()}${action.slice(1)}`;
  }
  return spell(name);
}

function departmentHeading(dept: string, count: number, continued = false): string {
  const known = DEPARTMENT_LABELS[dept as WorkerId];
  const { emoji, label } = known ?? { emoji: "🔹", label: spell(dept) };
  return `${emoji} <b>${esc(label)}</b>${continued ? " (continued)" : ` · ${count} tool${count === 1 ? "" : "s"}`}`;
}

function toolRow(tool: { name: string; description?: string }, registry: CapabilityRegistry): string {
  const what = firstSentence(tool.description ?? "");
  const marks = [
    registry.gated.has(tool.name) ? "asks first" : "",
    registry.isAvailable(tool.name) ? "" : "not set up on this server",
  ].filter(Boolean);
  return (
    `• <b>${esc(toolLabel(tool.name))}</b>` +
    (what ? ` — ${esc(what)}` : "") +
    (marks.length > 0 ? ` <i>· ${marks.join(" · ")}</i>` : "")
  );
}

/** One message per team where it fits; a team too big for one message continues in the next. */
export function renderCapabilities(registry: CapabilityRegistry): string[] {
  const header =
    "🧭 <b>Everything I can do</b> — every tool each team has, read from the live tool list.\n" +
    "<i>asks first = you approve before it acts. You never name a tool: say what you want in plain words.</i>";

  const messages: string[] = [];
  let current = header;
  const push = (block: string): void => {
    if (current.length + 2 + block.length <= MESSAGE_BUDGET) {
      current = `${current}\n\n${block}`;
    } else {
      messages.push(current);
      current = block;
    }
  };

  for (const [dept, tools] of Object.entries(registry.departments)) {
    const rows = tools.map((t) => toolRow(t, registry));
    let block = departmentHeading(dept, tools.length);
    for (const row of rows) {
      if (block.length + 1 + row.length > MESSAGE_BUDGET) {
        push(block);
        block = departmentHeading(dept, tools.length, true);
      }
      block = `${block}\n${row}`;
    }
    push(block);
  }
  messages.push(current);
  return messages;
}

/** The live registry, loaded on tap so the menu module never pulls the whole tool graph in at startup. */
export async function loadCapabilityRegistry(): Promise<CapabilityRegistry> {
  const [{ DEPARTMENT_TOOLS, HITL_GATED_TOOLS }, { isUnconfiguredTool }] = await Promise.all([
    import("../agents/capabilities.js"),
    import("./kernel-boot.js"),
  ]);
  return {
    departments: DEPARTMENT_TOOLS as CapabilityRegistry["departments"],
    gated: HITL_GATED_TOOLS,
    isAvailable: (name) => !isUnconfiguredTool(name),
  };
}

/**
 * Send the list, the menu keyboard on the last message so he can carry on from
 * there. A registry that fails to load is said, with the reason — a tap that
 * produces nothing is the failure the home screen exists to remove.
 */
export async function sendCapabilities(
  ctx: Context,
  keyboard: { inline_keyboard: { text: string; callback_data: string }[][] },
  load: () => Promise<CapabilityRegistry> = loadCapabilityRegistry,
): Promise<void> {
  let parts: string[];
  try {
    parts = renderCapabilities(await load());
  } catch (err) {
    log.error({ err: String(err) }, "Capability list failed to load");
    await ctx.reply(`❌ Couldn't load the capability list: ${esc(String((err as Error)?.message ?? err))}`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return;
  }
  for (const [i, part] of parts.entries()) {
    await ctx.reply(part, { parse_mode: "HTML", ...(i === parts.length - 1 ? { reply_markup: keyboard } : {}) });
  }
}
