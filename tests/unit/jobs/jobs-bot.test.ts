/**
 * The jobs bot registers the job commands, their wife_ aliases and the jh:
 * buttons, and nothing from the retired kernel (/ask, /task, /halt, free text
 * to a model). Every registered command is in the ☰ menu list and vice versa.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { registerJobsHandlers } = await import("../../../src/jobs/bot.js");
const { COMMAND_MENU } = await import("../../../src/gateway/command-menu.js");
const { buildChatAccessConfig } = await import("../../../src/gateway/chat-access.js");

function fakeBot() {
  const commands: string[] = [];
  const events: string[] = [];
  const bot = {
    use: vi.fn(),
    command: vi.fn((name: string) => commands.push(name)),
    on: vi.fn((event: string) => events.push(event)),
    catch: vi.fn(),
  };
  return { bot, commands, events };
}

const access = buildChatAccessConfig({ primaryChatId: "1", allowedChatIds: "", answerAllChatIds: "", ownerUserId: undefined });

describe("jobs bot handlers", () => {
  const { bot, commands, events } = fakeBot();
  registerJobsHandlers(bot as never, access);

  it("registers every job command and its wife_ alias", () => {
    for (const c of ["draft", "applied", "replied", "rejected", "profile", "jobs", "today", "fresh", "csv", "gaps"]) {
      expect(commands).toContain(c);
      expect(commands).toContain(`wife_${c}`);
    }
    expect(commands).toEqual(expect.arrayContaining(["start", "commands", "wife_commands"]));
  });

  it("registers nothing from the retired kernel", () => {
    for (const c of ["ask", "wife_ask", "task", "tasks", "halt", "resume", "reset", "login", "remind", "goals", "promote"]) {
      expect(commands).not.toContain(c);
    }
  });

  it("handles text (unknown commands and hints) and the jh: buttons", () => {
    expect(events).toEqual(["message:text", "callback_query:data"]);
  });

  it("the ☰ menu lists exactly what is registered", () => {
    expect([...commands].sort()).toEqual(COMMAND_MENU.map((e) => e.command).sort());
  });
});
