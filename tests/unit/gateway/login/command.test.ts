import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { buildChatAccessConfig } from "../../../../src/gateway/chat-access.js";
import { handleLogin, handleLoginReply, type LoginDeps } from "../../../../src/gateway/login/command.js";
import { PendingLogins } from "../../../../src/gateway/login/pending.js";
import type { LoginAdapter } from "../../../../src/gateway/login/types.js";
import type { LoginAudit, LoginEvent, LoginEventRow } from "../../../../src/gateway/login/login-audit.js";

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

  it("a finish with a next step hands over: step 1 is disposed, the next paste goes to step 2 with its state", async () => {
    const dispose1 = vi.fn();
    const dispose2 = vi.fn();
    const finish = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, html: "step 1 done", next: { html: "link 2", state: "S2", dispose: dispose2 } })
      .mockResolvedValueOnce({ ok: true, html: "all done" });
    const d = mk(adapter({ start: async () => ({ html: "link 1", state: "S1", dispose: dispose1 }), finish }));
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    const p1 = ctx({ chatId: 100, text: "code1code" });
    expect(await handleLoginReply(p1.c, d)).toBe(true);
    expect(dispose1).toHaveBeenCalled();
    expect(p1.replies[0]).toContain("step 1 done");
    expect(p1.replies[0]).toContain("/login cancel");
    const p2 = ctx({ chatId: 100, text: "code2code" });
    expect(await handleLoginReply(p2.c, d)).toBe(true);
    expect(finish).toHaveBeenLastCalledWith("default", "code2code", "S2");
    expect(dispose2).toHaveBeenCalled();
    expect(await d.pending.peek("100")).toBeUndefined();
  });

  it("a failed paste keeps the attempt open for a retry; a command is not swallowed", async () => {
    const a = adapter({ finish: vi.fn(async () => ({ ok: false, html: "bad paste" })) });
    const d = mk(a);
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    expect(await handleLoginReply(ctx({ chatId: 100, text: "typo4code" }).c, d)).toBe(true);
    expect(await d.pending.peek("100")).toBeDefined();
    expect(await handleLoginReply(ctx({ chatId: 100, text: "/status" }).c, d)).toBe(false);
  });

  it("L5: a token with whitespace in it is still consumed, deleted and finished with the whitespace removed", async () => {
    const a = adapter();
    const d = mk(a);
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    for (const text of ["sk-ant-oat01-abc def\nghi", "http://localhost:1455/cb?state=x&code=ab cd", "see https://localhost/auth/callback?code=9"]) {
      const m = ctx({ chatId: 100, text });
      expect(await handleLoginReply(m.c, d)).toBe(true);
      expect(m.c.deleteMessage).toHaveBeenCalled();
      await d.pending.begin("100", a, "default", { html: "again", state: "S" });
    }
    expect(a.finish).toHaveBeenNthCalledWith(1, "default", "sk-ant-oat01-abcdefghi", "S");
    expect(a.finish).toHaveBeenNthCalledWith(2, "default", "http://localhost:1455/cb?state=x&code=abcd", "S");
  });

  it("L8: when the paste cannot be deleted, the reply says to delete it yourself", async () => {
    const d = mk(adapter());
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    const m = ctx({ chatId: 100, text: "code1code" });
    m.c.deleteMessage.mockRejectedValueOnce(new Error("message can't be deleted"));
    expect(await handleLoginReply(m.c, d)).toBe(true);
    expect(m.replies[0]).toContain("Delete it yourself");
  });

  it("L11: a failed paste whose attempt is over drops it, so the retry is not told 'attempt has ended'", async () => {
    const d = mk(adapter({ finish: vi.fn(async () => ({ ok: false, ended: true, html: "Send /login tool again" })) }));
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    expect(await handleLoginReply(ctx({ chatId: 100, text: "typo4code" }).c, d)).toBe(true);
    expect(await d.pending.peek("100")).toBeUndefined();
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


function memoryAudit(rows: LoginEventRow[] = []): LoginAudit & { events: LoginEvent[] } {
  const events: LoginEvent[] = [];
  return {
    events,
    record: async (e) => void events.push(e),
    recent: async (n) => rows.slice(0, n),
  };
}

describe("/login <tool> logout and the audit trail", () => {
  it("logout signs the target out, answers with the adapter's proof, and records one ok row without a detail", async () => {
    const logout = vi.fn(async () => ({ ok: true, html: "signed out, a call now fails" }));
    const audit = memoryAudit();
    const d = { ...mk(adapter({ logout })), audit };
    const { c, replies } = ctx({ chatId: 100, match: "tool logout" });
    await handleLogin(c, d);
    expect(logout).toHaveBeenCalledWith("default");
    expect(replies[0]).toBe("signed out, a call now fails");
    expect(audit.events).toEqual([{ tool: "tool", target: "default", kind: "logout", ok: true, detail: undefined }]);
  });

  it("a logout that did not take records ok:false with the reason, and says so to the founder", async () => {
    const audit = memoryAudit();
    const d = { ...mk(adapter({ logout: async () => ({ ok: false, html: "still <b>signed in</b>" }) })), audit };
    const { c, replies } = ctx({ chatId: 100, match: "tool logout" });
    await handleLogin(c, d);
    expect(replies[0]).toContain("still");
    expect(audit.events[0]).toMatchObject({ kind: "logout", ok: false });
  });

  it("a throwing logout is reported and recorded as a failure, never as a success", async () => {
    const audit = memoryAudit();
    const d = { ...mk(adapter({ logout: async () => { throw new Error("boom"); } })), audit };
    const { c, replies } = ctx({ chatId: 100, match: "tool logout" });
    await handleLogin(c, d);
    expect(replies[0]).toContain("boom");
    expect(audit.events[0]).toMatchObject({ kind: "logout", ok: false, detail: "boom" });
  });

  it("a tool with no sign-out says so, and records nothing", async () => {
    const audit = memoryAudit();
    const { c, replies } = ctx({ chatId: 100, match: "tool logout" });
    await handleLogin(c, { ...mk(adapter()), audit });
    expect(replies[0]).toContain("no sign-out");
    expect(audit.events).toEqual([]);
  });

  it("a multi-target tool asks which one, and signs out nothing", async () => {
    const logout = vi.fn(async () => ({ ok: true, html: "x" }));
    const { c, replies } = ctx({ chatId: 100, match: "tool logout" });
    await handleLogin(c, mk(adapter({ targets: ["one", "two"], logout })));
    expect(replies[0]).toContain("Which one?");
    expect(logout).not.toHaveBeenCalled();
  });

  it("logout drops a login that is waiting for a code, so the old link cannot sign back in", async () => {
    const dispose = vi.fn();
    const a = adapter({ start: async () => ({ html: "link", state: "S", dispose }), logout: async () => ({ ok: true, html: "out" }) });
    const d = mk(a);
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    await handleLogin(ctx({ chatId: 100, match: "tool logout" }).c, d);
    expect(dispose).toHaveBeenCalled();
    expect(await d.pending.peek("100")).toBeUndefined();
  });

  it("a finished login (ok or not) and a refused start are recorded; the pasted code never is", async () => {
    const audit = memoryAudit();
    const d = { ...mk(adapter({ finish: async () => ({ ok: false, html: "code was rejected" }) })), audit };
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, d);
    await handleLoginReply(ctx({ chatId: 100, text: "4/0SECRET-CODE" }).c, d);
    expect(audit.events).toEqual([{ tool: "tool", target: "default", kind: "login", ok: false, detail: "code was rejected" }]);
    expect(JSON.stringify(audit.events)).not.toContain("SECRET");

    const failing = memoryAudit();
    await handleLogin(ctx({ chatId: 100, match: "tool" }).c, { ...mk(adapter({ start: async () => { throw new Error("no agy"); } })), audit: failing });
    expect(failing.events[0]).toMatchObject({ kind: "login", ok: false });
  });

  it("an audit write that fails never changes what the founder is told", async () => {
    const audit: LoginAudit = { record: async () => { throw new Error("db down"); }, recent: async () => [] };
    const d = { ...mk(adapter({ logout: async () => ({ ok: true, html: "signed out" }) })), audit };
    const { c, replies } = ctx({ chatId: 100, match: "tool logout" });
    await handleLogin(c, d);
    expect(replies).toEqual(["signed out"]);
  });

  it("remove records a remove event", async () => {
    const audit = memoryAudit();
    const d = { ...mk(adapter({ targets: ["wife"], remove: async () => ({ ok: true, html: "gone" }) })), audit };
    await handleLogin(ctx({ chatId: 100, match: "tool remove wife" }).c, d);
    expect(audit.events[0]).toMatchObject({ tool: "tool", target: "wife", kind: "remove", ok: true });
  });

  it("/login history lists the newest events; empty and a database failure each say so", async () => {
    const rows: LoginEventRow[] = [
      { tool: "agy", target: "default", kind: "logout", ok: true, at: new Date(Date.UTC(2026, 9, 5, 14, 2)) },
      { tool: "google", target: "wife", kind: "login", ok: false, detail: "Google refused", at: new Date(Date.UTC(2026, 9, 5, 13, 0)) },
    ];
    const full = ctx({ chatId: 100, match: "history" });
    await handleLogin(full.c, { ...mk(adapter()), audit: memoryAudit(rows) });
    expect(full.replies[0]).toContain("✅ 2026-10-05 14:02 UTC — agy: signed out");
    expect(full.replies[0]).toContain("❌ 2026-10-05 13:00 UTC — google wife: sign-in failed (Google refused)");

    const none = ctx({ chatId: 100, match: "history" });
    await handleLogin(none.c, { ...mk(adapter()), audit: memoryAudit() });
    expect(none.replies[0]).toContain("No login or logout has been recorded yet.");

    const down = ctx({ chatId: 100, match: "history" });
    await handleLogin(down.c, { ...mk(adapter()), audit: { record: async () => undefined, recent: async () => { throw new Error("x"); } } });
    expect(down.replies[0]).toContain("Could not read the login history");
  });

  it("the status screen lists the sign-out commands and /login history", async () => {
    const { c, replies } = ctx({ chatId: 100 });
    await handleLogin(c, mk(adapter({ logout: async () => ({ ok: true, html: "x" }) })));
    expect(replies.join("\n")).toContain("/login tool logout");
    expect(replies.join("\n")).toContain("/login history");
  });

  it("history and logout are founder-DM only, like every /login command", async () => {
    const audit = memoryAudit([{ tool: "agy", target: "default", kind: "login", ok: true, at: new Date() }]);
    const { c, replies } = ctx({ chatId: -5, type: "group", match: "history" });
    await handleLogin(c, { ...mk(adapter()), audit });
    expect(replies[0]).toContain("only in your private chat");
  });
});
