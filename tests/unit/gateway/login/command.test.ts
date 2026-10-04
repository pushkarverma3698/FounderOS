import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { buildChatAccessConfig } from "../../../../src/gateway/chat-access.js";
import { handleLogin, handleLoginReply, type LoginDeps } from "../../../../src/gateway/login/command.js";
import { PendingLogins } from "../../../../src/gateway/login/pending.js";
import type { LoginAdapter } from "../../../../src/gateway/login/types.js";

const access = buildChatAccessConfig({ primaryChatId: "100", allowedChatIds: "-5" });

function adapter(over: Partial<LoginAdapter> = {}): LoginAdapter {
  return {
    id: "tool",
    title: "Tool",
    targets: ["default"],
    start: async () => ({ html: "open the link", state: "S" }),
    finish: vi.fn(async () => ({ ok: true, html: "done" })),
    status: async () => [{ target: "default", label: "Tool", ok: true, detail: "fine" }],
    ...over,
  };
}
const mk = (a: LoginAdapter): LoginDeps => ({ adapters: [a], pending: new PendingLogins(), access });

function ctx(o: { chatId: number; type?: string; text?: string; match?: string }) {
  const replies: string[] = [];
  const c = {
    chat: { id: o.chatId, type: o.type ?? "private" },
    from: { id: o.chatId },
    match: o.match ?? "",
    message: { text: o.text ?? "" },
    reply: vi.fn(async (t: string) => void replies.push(t)),
    deleteMessage: vi.fn(async () => true),
  };
  return { c: c as unknown as Context & typeof c, replies };
}

describe("/login", () => {
  it("shows status when called bare", async () => {
    const { c, replies } = ctx({ chatId: 100 });
    await handleLogin(c, mk(adapter()));
    expect(replies.join("\n")).toContain("✅ Tool — fine");
  });

  it("a row nobody could check live shows ❔, not ✅", async () => {
    const { c, replies } = ctx({ chatId: 100 });
    await handleLogin(c, mk(adapter({ status: async () => [{ target: "default", label: "Tool", ok: true, unverified: true, detail: "exited 127" }] })));
    expect(replies.join("\n")).toContain("❔ Tool — exited 127");
    expect(replies.join("\n")).not.toContain("✅");
  });

  it("an adapter that accepts an email hint gets it as the second argument, and a single-target tool needs no target word", async () => {
    const start = vi.fn(async (_target: string, _hint?: string) => ({ html: "open the link", state: "S" }));
    const { c, replies } = ctx({ chatId: 100, match: "tool Me@Example.com" });
    await handleLogin(c, mk(adapter({ acceptsEmailHint: true, start })));
    expect(start).toHaveBeenCalledWith("default", "me@example.com");
    expect(replies.join("\n")).toContain("open the link");
  });

  it("an adapter that does not accept a hint still treats an email as an unknown target", async () => {
    const start = vi.fn(async () => ({ html: "open the link" }));
    const { c, replies } = ctx({ chatId: 100, match: "tool me@example.com" });
    await handleLogin(c, mk(adapter({ start })));
    expect(start).not.toHaveBeenCalled();
    expect(replies.join("\n")).toContain("Which one?");
  });

  it("the usage line advertises the optional email only for adapters that take one", async () => {
    const { c, replies } = ctx({ chatId: 100 });
    await handleLogin(c, mk(adapter({ acceptsEmailHint: true })));
    expect(replies.join("\n")).toContain("/login tool [email]");
  });

  it("refuses an allow-listed group and a stranger", async () => {
    for (const id of [-5, 7]) {
      const { c, replies } = ctx({ chatId: id, type: id < 0 ? "group" : "private", match: "tool" });
      const d = mk(adapter());
      await handleLogin(c, d);
      expect(replies[0]).toContain("only in your private chat");
      expect(await d.pending.peek(String(id))).toBeUndefined();
    }
  });

  it("start parks the attempt; the next plain message is consumed, deleted and finished", async () => {
    const a = adapter();
    const d = mk(a);
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    const paste = ctx({ chatId: 100, text: "4/0SECRET-CODE" });
    expect(await handleLoginReply(paste.c, d)).toBe(true);
    expect(paste.c.deleteMessage).toHaveBeenCalled();
    expect(a.finish).toHaveBeenCalledWith("default", "4/0SECRET-CODE", "S");
    expect(paste.replies).toEqual(["done"]);
    expect(await handleLoginReply(ctx({ chatId: 100, text: "hi" }).c, d)).toBe(false); // attempt closed
  });

  it("a failed paste keeps the attempt open for a retry; a command is not swallowed", async () => {
    const a = adapter({ finish: vi.fn(async () => ({ ok: false, html: "bad paste" })) });
    const d = mk(a);
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    expect(await handleLoginReply(ctx({ chatId: 100, text: "typo4code" }).c, d)).toBe(true);
    expect(await d.pending.peek("100")).toBeDefined();
    expect(await handleLoginReply(ctx({ chatId: 100, text: "/status" }).c, d)).toBe(false);
  });

  it("a sentence typed while a login waits reaches the kernel, untouched; the attempt stays open", async () => {
    const a = adapter();
    const d = mk(a);
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    for (const text of ["what's on today", "yesterday", "where are we on 3 tasks"]) {
      const m = ctx({ chatId: 100, text });
      expect(await handleLoginReply(m.c, d)).toBe(false);
      expect(m.c.deleteMessage).not.toHaveBeenCalled();
    }
    expect(a.finish).not.toHaveBeenCalled();
    expect(await d.pending.peek("100")).toBeDefined();
  });

  it("/login cancel ends a waiting attempt and disposes it", async () => {
    const dispose = vi.fn();
    const d = mk(adapter({ start: async () => ({ html: "h", dispose }) }));
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    const cancel = ctx({ chatId: 100, match: "cancel" });
    await handleLogin(cancel.c, d);
    expect(dispose).toHaveBeenCalled();
    expect(await d.pending.peek("100")).toBeUndefined();
    expect(cancel.replies[0]).toContain("Cancelled the Tool login");
    const none = ctx({ chatId: 100, match: "cancel" });
    await handleLogin(none.c, d);
    expect(none.replies[0]).toContain("No login is waiting");
  });

  it("expires an attempt after the TTL and disposes it", async () => {
    let now = 0;
    const dispose = vi.fn();
    const a = adapter({ start: async () => ({ html: "h", dispose }) });
    const d: LoginDeps = { adapters: [a], pending: new PendingLogins(() => now), access };
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    now = 11 * 60_000;
    expect(await handleLoginReply(ctx({ chatId: 100, text: "late" }).c, d)).toBe(false);
    expect(dispose).toHaveBeenCalled();
  });

  it("add <name> starts a login for a new target; a refused name starts nothing", async () => {
    const start = vi.fn(async () => ({ html: "open the link", state: "S" }));
    const a = adapter({ targets: ["one", "two"], start, addProblem: (n) => (n === "bad" ? "no good" : undefined) });
    const d = mk(a);
    const refused = ctx({ chatId: 100, match: "tool add bad" });
    await handleLogin(refused.c, d);
    expect(refused.replies[0]).toBe("no good");
    expect(start).not.toHaveBeenCalled();
    await handleLogin(ctx({ chatId: 100, match: "tool add wife" }).c, d);
    expect(start).toHaveBeenCalledWith("wife");
    expect((await d.pending.peek("100"))?.target).toBe("wife");
  });

  it("an unknown target without 'add' is not created by accident", async () => {
    const start = vi.fn();
    const { c, replies } = ctx({ chatId: 100, match: "tool wfe" });
    await handleLogin(c, mk(adapter({ targets: ["one"], start, addProblem: () => undefined })));
    expect(replies[0]).toContain("New account: /login tool add");
    expect(start).not.toHaveBeenCalled();
  });

  it("remove <name> signs a known target out; an unknown one asks which", async () => {
    const remove = vi.fn(async () => ({ ok: true, html: "removed" }));
    const d = mk(adapter({ targets: ["one", "wife"], remove }));
    const unknown = ctx({ chatId: 100, match: "tool remove nobody" });
    await handleLogin(unknown.c, d);
    expect(unknown.replies[0]).toContain("Which one?");
    const known = ctx({ chatId: 100, match: "tool remove wife" });
    await handleLogin(known.c, d);
    expect(remove).toHaveBeenCalledWith("wife");
    expect(known.replies[0]).toBe("removed");
  });
});

