/**
 * /focus and /projects: the founder sets what he is focused on in two seconds,
 * with no model call.
 * =============================================================================
 * 2026-09-29, production: "what am I focused on?" was answered from June's
 * seed, because nothing let the founder change it short of a database edit
 * (update_context rejected `current_focus` as an unrecognised key) and nothing
 * dated it. /focus and /projects write the two keys through the same guard
 * update_context uses, stamp them as the founder's, and never reach a model.
 *
 * These tests drive the REAL handler stack (registerHandlers) with raw Telegram
 * updates, on top of the real queries.ts and an in-memory founder_context row,
 * so they fail on what the founder would see and on what lands in the row. Two
 * things are replaced on purpose: the kernel and every model constructor THROW,
 * which is how "0 model calls" is observed rather than asserted by reading code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";

const runKernelText = vi.fn(async (..._args: unknown[]): Promise<void> => {
  throw new Error("kernel turn started by a command that must make 0 model calls");
});
const resumeKernel = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("../../../src/gateway/kernel-run.js", () => ({
  runKernelText: (...args: unknown[]) => runKernelText(...args),
  resumeKernel: (...args: unknown[]) => resumeKernel(...args),
  withChatTurnLock: vi.fn(),
  restorePendingApproval: vi.fn(),
}));

// The command logs a failed database call at error level; the tests read those lines
// from here (and stay quiet). Every other logger export stays real.
const mockLogError = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infra/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/infra/logger.js")>();
  return { ...actual, childLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: mockLogError, debug: vi.fn() }) };
});

const modelCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../../src/agents/model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/agents/model.js")>();
  const throwing = (name: string) => () => {
    modelCalls.count += 1;
    throw new Error(`${name} called by a command that must make 0 model calls`);
  };
  return {
    ...actual,
    getModel: throwing("getModel"),
    getSupervisorModel: throwing("getSupervisorModel"),
    getWorkerModel: throwing("getWorkerModel"),
    buildFallbackModels: throwing("buildFallbackModels"),
    getModelFallbackMiddleware: throwing("getModelFallbackMiddleware"),
  };
});

const store = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  writes: 0,
  failReads: false,
  failWrites: false,
  failReadsAfterWrite: false,
  dropWrites: false,
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (store.failReads || (store.failReadsAfterWrite && store.writes > 0)) {
              throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
            }
            return store.row ? [{ data: structuredClone(store.row) }] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (v: { data: Record<string, unknown> }) => ({
        onConflictDoUpdate: async ({ set }: { set: { data: Record<string, unknown> } }) => {
          if (store.failWrites) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
          store.writes += 1;
          if (store.dropWrites) return; // a write the database accepted and did not keep
          store.row = structuredClone(store.row ? set.data : v.data);
        },
      }),
    }),
  }),
}));

import { registerHandlers } from "../../../src/gateway/telegram.js";
import { OWNER_ONLY_COMMANDS, buildChatAccessConfig } from "../../../src/gateway/chat-access.js";
import { COMMAND_MENU } from "../../../src/gateway/command-menu.js";
import { emptyStateHtml } from "../../../src/gateway/empty-states.js";
import { buildMenuSection } from "../../../src/gateway/home-menu.js";
import { reconcileSeededContext } from "../../../src/db/founder-context.js";
import { CONTEXT_META_KEY, CONTEXT_STALE_MARKER } from "../../../src/db/context-meta.js";
import {
  CONTEXT_FOCUS_MAX_CHARS,
  CONTEXT_PROJECTS_MAX_ITEMS,
  CONTEXT_PROJECT_MAX_CHARS,
} from "../../../src/tools/context-guard.js";

const BOT_ID = 999;
const BOT_USERNAME = "founderos_bot";
const OWNER = 4242; // the founder: in a private chat, chat id === user id
const GUEST = 7777; // someone else in an allow-listed group
const ALLOWED_GROUP = -100555;

/** 11:00 IST on 2026-09-30. */
const NOW = new Date("2026-09-30T05:30:00.000Z");
const TODAY = "2026-09-30";
const JUNE_FOCUS =
  "Phase D-Bis: 3 proof showcases on proof.turicks.com + LinkedIn build-in-public + Proof Drops to AI/dev-tool startups";
const FOUNDER_META = { at: NOW.toISOString(), source: "founder" };

interface SentCall {
  method: string;
  payload: Record<string, unknown>;
}

let sent: SentCall[] = [];
let updateId = 0;

function makeBot(): Bot {
  const bot = new Bot("1:test", {
    botInfo: {
      id: BOT_ID,
      is_bot: true,
      first_name: "FounderOS",
      username: BOT_USERNAME,
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as UserFromGetMe,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "sendMessage"
        ? { message_id: 1, date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: "private" } }
        : true;
    return { ok: true, result } as never;
  });
  registerHandlers(bot, buildChatAccessConfig({ primaryChatId: String(OWNER), allowedChatIds: String(ALLOWED_GROUP) }));
  return bot;
}

function chat(id: number): Record<string, unknown> {
  return id > 0 ? { id, type: "private", first_name: "Owner" } : { id, type: "supergroup", title: "Us" };
}

async function send(bot: Bot, text: string, opts: { chatId?: number; fromId?: number } = {}): Promise<void> {
  const chatId = opts.chatId ?? OWNER;
  const end = text.indexOf(" ");
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: chat(chatId),
      from: { id: opts.fromId ?? OWNER, is_bot: false, first_name: "U" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: end === -1 ? text.length : end }],
    },
  } as never);
}

const replies = (): string[] => sent.filter((c) => c.method === "sendMessage").map((c) => String(c.payload["text"]));
const lastReply = (): string => replies().at(-1) ?? "";
const meta = (): Record<string, unknown> => (store.row?.[CONTEXT_META_KEY] ?? {}) as Record<string, unknown>;

let bot: Bot;

beforeEach(() => {
  sent = [];
  store.row = undefined;
  store.writes = 0;
  store.failReads = false;
  store.failWrites = false;
  store.failReadsAfterWrite = false;
  store.dropWrites = false;
  modelCalls.count = 0;
  mockLogError.mockClear();
  runKernelText.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  bot = makeBot();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/focus <text>", () => {
  it("sets current_focus, dates it as the founder's, and replies with the text and the date", async () => {
    store.row = { current_focus: JUNE_FOCUS, tech_stack: "v3 kernel" };

    await send(bot, "/focus Close the Acme pilot");

    expect(store.row?.["current_focus"]).toBe("Close the Acme pilot");
    expect(meta()["current_focus"]).toEqual(FOUNDER_META);
    expect(store.row?.["tech_stack"]).toBe("v3 kernel"); // nothing else touched
    expect(lastReply()).toContain("Close the Acme pilot");
    expect(lastReply()).toContain(TODAY);
  });

  it("creates the row when the founder has no context yet", async () => {
    await send(bot, "/focus Close the Acme pilot");
    expect(store.row?.["current_focus"]).toBe("Close the Acme pilot");
    expect(meta()["current_focus"]).toEqual(FOUNDER_META);
  });

  it("trims and puts a multi-line focus on one line", async () => {
    await send(bot, "/focus   Close the Acme   pilot\nand ship the proof page  ");
    expect(store.row?.["current_focus"]).toBe("Close the Acme pilot and ship the proof page");
  });

  it("moves the date when he sets it again later", async () => {
    await send(bot, "/focus First");
    vi.setSystemTime(new Date("2026-10-15T05:30:00.000Z"));
    await send(bot, "/focus Second");
    expect(store.row?.["current_focus"]).toBe("Second");
    expect(meta()["current_focus"]).toEqual({ at: "2026-10-15T05:30:00.000Z", source: "founder" });
  });

  it("stores a focus identical to the retired seed default as HIS, so the next deploy keeps it", async () => {
    await send(bot, `/focus ${JUNE_FOCUS}`);

    const { data, retired } = reconcileSeededContext(store.row ?? {}, {}, new Date("2026-10-01T05:30:00.000Z"));
    expect(retired).toEqual([]);
    expect(data["current_focus"]).toBe(JUNE_FOCUS);
  });

  it("echoes text with <, > and & as plain text, not as HTML the founder's own words could break", async () => {
    await send(bot, "/focus Ship <b>fast</b> & test");
    expect(store.row?.["current_focus"]).toBe("Ship <b>fast</b> & test");
    const reply = sent.filter((c) => c.method === "sendMessage").at(-1);
    expect(String(reply?.payload["text"])).toContain("Ship <b>fast</b> & test");
    expect(reply?.payload["parse_mode"]).toBeUndefined();
  });

  it("refuses a focus over the limit, names the limit and the length, and changes nothing", async () => {
    store.row = { current_focus: JUNE_FOCUS };
    const tooLong = "x".repeat(CONTEXT_FOCUS_MAX_CHARS + 1);

    await send(bot, `/focus ${tooLong}`);

    expect(store.row).toEqual({ current_focus: JUNE_FOCUS });
    expect(store.writes).toBe(0);
    expect(lastReply()).toContain(String(CONTEXT_FOCUS_MAX_CHARS));
    expect(lastReply()).toContain(String(CONTEXT_FOCUS_MAX_CHARS + 1));
    expect(lastReply()).toMatch(/not saved/i);
  });

  it("accepts a focus of exactly the limit", async () => {
    await send(bot, `/focus ${"x".repeat(CONTEXT_FOCUS_MAX_CHARS)}`);
    expect(String(store.row?.["current_focus"])).toHaveLength(CONTEXT_FOCUS_MAX_CHARS);
  });

  it("says nothing was changed, and why, when the database is down", async () => {
    store.failWrites = true;

    await send(bot, "/focus Close the Acme pilot");

    expect(store.row).toBeUndefined();
    expect(lastReply()).toMatch(/not saved/i);
    expect(lastReply()).toContain("ECONNREFUSED");
    expect(lastReply()).toMatch(/database/i);
    // ... and leaves a log line naming the failed write, for the operator.
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining("ECONNREFUSED"), key: "current_focus" }),
      expect.stringContaining("write failed"),
    );
  });

  it("says the value is saved but could not be read back, when only the read-back fails", async () => {
    store.failReadsAfterWrite = true; // the read before the write works, the one after it does not

    await send(bot, "/focus Close the Acme pilot");

    expect(store.row?.["current_focus"]).toBe("Close the Acme pilot"); // it IS saved
    expect(lastReply()).toMatch(/saved, but i could not read it back/i);
    expect(lastReply()).toContain("ECONNREFUSED");
    expect(lastReply()).toContain("/focus"); // and how to check
    expect(mockLogError).toHaveBeenCalledWith(expect.objectContaining({ key: "current_focus" }), expect.stringContaining("read-back failed"));
  });
});

describe("/focus when the write cannot be seen afterwards", () => {
  it("does not claim a saved focus it cannot show: it says the read-back found nothing, and how to check", async () => {
    store.dropWrites = true;

    await send(bot, "/focus Close the Acme pilot");

    expect(lastReply()).toMatch(/saved, but reading it back did not show your focus/i);
    expect(lastReply()).toContain("/focus");
    expect(lastReply()).not.toContain("Focus saved:");
  });
});

describe("/focus with no text", () => {
  it("shows the focus and the date he last confirmed it", async () => {
    store.row = { current_focus: "Close the Acme pilot", [CONTEXT_META_KEY]: { current_focus: { at: "2026-09-29T19:00:00.000Z", source: "founder" } } };

    await send(bot, "/focus");

    expect(lastReply()).toContain("Close the Acme pilot");
    expect(lastReply()).toContain("(confirmed 2026-09-30)");
    expect(lastReply()).not.toContain(CONTEXT_STALE_MARKER);
    expect(store.writes).toBe(0);
  });

  it("flags June's focus as undated instead of showing it as current, and says what to send", async () => {
    store.row = { current_focus: JUNE_FOCUS, last_updated: "2026-09-28T13:19:27Z" };

    await send(bot, "/focus");

    expect(lastReply()).toContain(JUNE_FOCUS);
    expect(lastReply()).toContain(`${CONTEXT_STALE_MARKER} date unknown`);
    expect(lastReply()).not.toContain("2026-09-28");
    expect(lastReply()).toContain("/focus <text>");
  });

  it("flags a focus last confirmed more than a month ago, with that date", async () => {
    store.row = { current_focus: "Old plan", [CONTEXT_META_KEY]: { current_focus: { at: "2026-06-12T08:00:00.000Z", source: "founder" } } };

    await send(bot, "/focus");

    expect(lastReply()).toContain(`${CONTEXT_STALE_MARKER} last confirmed 2026-06-12`);
  });

  it("says how to set one when there is none", async () => {
    store.row = { tech_stack: "v3 kernel" };
    await send(bot, "/focus");
    expect(lastReply()).toBe(emptyStateHtml("focus"));

    store.row = undefined;
    await send(bot, "/focus");
    expect(lastReply()).toBe(emptyStateHtml("focus"));
  });

  it("treats a bare space as no text", async () => {
    await send(bot, "/focus    ");
    expect(lastReply()).toBe(emptyStateHtml("focus"));
  });

  it("says the database is down, and that it changed nothing, when it cannot read", async () => {
    store.failReads = true;
    await send(bot, "/focus");
    expect(lastReply()).toContain("ECONNREFUSED");
    expect(lastReply()).toMatch(/database/i);
  });
});

describe("/projects", () => {
  it("sets active_projects from a ;-separated line, one entry each, dated as the founder's", async () => {
    await send(bot, "/projects FounderOS; Naggar site ; Cinematic launch");

    expect(store.row?.["active_projects"]).toEqual(["FounderOS", "Naggar site", "Cinematic launch"]);
    expect(meta()["active_projects"]).toEqual(FOUNDER_META);
    expect(lastReply()).toContain("1. FounderOS");
    expect(lastReply()).toContain("2. Naggar site");
    expect(lastReply()).toContain("3. Cinematic launch");
    expect(lastReply()).toContain(TODAY);
  });

  it("drops empty entries", async () => {
    await send(bot, "/projects  ;; FounderOS ;  ; ");
    expect(store.row?.["active_projects"]).toEqual(["FounderOS"]);
  });

  it("sets a single project", async () => {
    await send(bot, "/projects FounderOS");
    expect(store.row?.["active_projects"]).toEqual(["FounderOS"]);
  });

  it("refuses a line with no project names, and changes nothing", async () => {
    store.row = { active_projects: ["Old"] };

    await send(bot, "/projects ; ;");

    expect(store.row).toEqual({ active_projects: ["Old"] });
    expect(lastReply()).toMatch(/no project names/i);
    expect(lastReply()).toContain("/projects <a>; <b>");
  });

  it("refuses more projects than allowed, and names the limit and the count", async () => {
    const line = Array.from({ length: CONTEXT_PROJECTS_MAX_ITEMS + 1 }, (_, i) => `P${i + 1}`).join("; ");

    await send(bot, `/projects ${line}`);

    expect(store.row).toBeUndefined();
    expect(lastReply()).toContain(String(CONTEXT_PROJECTS_MAX_ITEMS));
    expect(lastReply()).toContain(String(CONTEXT_PROJECTS_MAX_ITEMS + 1));
    expect(lastReply()).toMatch(/not saved/i);
  });

  it("refuses a project over the limit, names which one and the limit, and changes nothing", async () => {
    await send(bot, `/projects Short; ${"y".repeat(CONTEXT_PROJECT_MAX_CHARS + 1)}`);

    expect(store.row).toBeUndefined();
    expect(lastReply()).toContain("entry 2 ");
    expect(lastReply()).toContain(String(CONTEXT_PROJECT_MAX_CHARS));
  });

  it("shows the list, numbered, with the date he last confirmed it", async () => {
    store.row = {
      active_projects: ["FounderOS", "Naggar site"],
      [CONTEXT_META_KEY]: { active_projects: { at: "2026-09-29T19:00:00.000Z", source: "founder" } },
    };

    await send(bot, "/projects");

    expect(lastReply()).toContain("1. FounderOS");
    expect(lastReply()).toContain("2. Naggar site");
    expect(lastReply()).toContain("(confirmed 2026-09-30)");
    expect(store.writes).toBe(0);
  });

  it("flags June's undated project list instead of showing it as current", async () => {
    store.row = { active_projects: ["FounderOS v2 — production LangGraph multi-agent OS"] };
    await send(bot, "/projects");
    expect(lastReply()).toContain("FounderOS v2");
    expect(lastReply()).toContain(`${CONTEXT_STALE_MARKER} date unknown`);
    expect(lastReply()).toContain("/projects <a>; <b>");
  });

  it("says how to set them when there are none", async () => {
    await send(bot, "/projects");
    expect(lastReply()).toBe(emptyStateHtml("projects"));
    store.row = { active_projects: [] };
    await send(bot, "/projects");
    expect(lastReply()).toBe(emptyStateHtml("projects"));
  });

  it("says nothing was changed, and why, when the database is down", async () => {
    store.failWrites = true;
    await send(bot, "/projects FounderOS; Naggar");
    expect(store.row).toBeUndefined();
    expect(lastReply()).toMatch(/not saved/i);
    expect(lastReply()).toContain("ECONNREFUSED");
  });
});

describe("neither command reaches a model", () => {
  it("runs every form of both commands without a kernel turn or a model constructor", async () => {
    const lines = [
      "/focus Close the Acme pilot",
      "/focus",
      `/focus ${"x".repeat(CONTEXT_FOCUS_MAX_CHARS + 1)}`,
      "/projects FounderOS; Naggar",
      "/projects",
      "/projects ; ;",
    ];
    for (const line of lines) await send(bot, line);

    expect(replies()).toHaveLength(lines.length); // every one was answered
    expect(runKernelText).not.toHaveBeenCalled();
    expect(modelCalls.count).toBe(0);
  });
});

describe("owner only", () => {
  it("lists both commands with the other system-level ones", () => {
    expect(OWNER_ONLY_COMMANDS.has("focus")).toBe(true);
    expect(OWNER_ONLY_COMMANDS.has("projects")).toBe(true);
  });

  it("refuses a guest in an allow-listed group, changes nothing, and lets the founder in the same group through", async () => {
    store.row = { current_focus: JUNE_FOCUS };

    await send(bot, `/focus@${BOT_USERNAME} Take over`, { chatId: ALLOWED_GROUP, fromId: GUEST });
    await send(bot, `/projects@${BOT_USERNAME} Take; over`, { chatId: ALLOWED_GROUP, fromId: GUEST });

    expect(replies()).toEqual(["Only the owner can run /focus.", "Only the owner can run /projects."]);
    expect(store.row).toEqual({ current_focus: JUNE_FOCUS });
    expect(store.writes).toBe(0);

    await send(bot, `/focus@${BOT_USERNAME} Close the Acme pilot`, { chatId: ALLOWED_GROUP, fromId: OWNER });
    expect(store.row?.["current_focus"]).toBe("Close the Acme pilot");
    expect(meta()["current_focus"]).toEqual(FOUNDER_META);
  });

  it("does not let a guest READ the focus either: it is the founder's business context", async () => {
    store.row = { current_focus: "Confidential plan" };
    await send(bot, `/focus@${BOT_USERNAME}`, { chatId: ALLOWED_GROUP, fromId: GUEST });
    expect(replies().join("\n")).not.toContain("Confidential plan");
  });
});

describe("discoverable", () => {
  it("is in the ☰ menu and named on the System screen, next to the commands it sits with", () => {
    for (const command of ["focus", "projects"]) {
      expect(COMMAND_MENU.some((e) => e.command === command), command).toBe(true);
      expect(buildMenuSection("system"), command).toContain(`/${command}`);
    }
  });
});

describe("empty states show one tappable example (P2-3)", () => {
  const lastSend = (): SentCall | undefined => sent.filter((c) => c.method === "sendMessage").at(-1);

  it("/focus with nothing set sends the example as HTML so Telegram makes it tappable", async () => {
    await send(bot, "/focus");
    expect(lastReply()).toContain("<code>/focus ");
    expect(lastSend()?.payload["parse_mode"]).toBe("HTML");
  });

  it("/projects with nothing set sends the example as HTML", async () => {
    await send(bot, "/projects");
    expect(lastReply()).toContain("<code>/projects ");
    expect(lastSend()?.payload["parse_mode"]).toBe("HTML");
  });

  it("a bare /remind shows the example and starts no kernel turn", async () => {
    await send(bot, "/remind");
    expect(lastReply()).toBe(emptyStateHtml("remind"));
    expect(lastSend()?.payload["parse_mode"]).toBe("HTML");
    expect(runKernelText).not.toHaveBeenCalled();
  });

  it("a saved focus is still plain text: the founder's own <, > and & are never parsed", async () => {
    store.row = { current_focus: "Ship <b>fast</b>" };
    await send(bot, "/focus");
    expect(lastSend()?.payload["parse_mode"]).toBeUndefined();
  });
});
