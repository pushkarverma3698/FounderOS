import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/infra/logger.js", () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createAgyRemoteAdapter, socketRequest } from "../../../../src/gateway/login/adapters/agy-remote.js";
import { createAgyHelper } from "../../../../src/gateway/login/agy-helper.js";
import { parseRequest, type AgyRequest, type AgyResponse } from "../../../../src/gateway/login/agy-protocol.js";
import type { LoginAdapter } from "../../../../src/gateway/login/types.js";

const CODE = "4/0AX4XfWgSECRETAGYCODE";

function realAdapter(over: Partial<LoginAdapter> = {}): LoginAdapter & { disposed: ReturnType<typeof vi.fn> } {
  const disposed = vi.fn();
  return {
    id: "agy",
    title: "Antigravity (agy)",
    targets: ["default"],
    start: vi.fn(async () => ({ html: "open the link", state: { child: 1 }, dispose: disposed })),
    finish: vi.fn(async () => ({ ok: true, html: "signed in" })),
    logout: vi.fn(async () => ({ ok: true, html: "signed out" })),
    status: async () => [{ target: "default", label: "Antigravity (agy)", ok: true, detail: "works" }],
    ...over,
    disposed,
  };
}

describe("parseRequest", () => {
  it("accepts the five operations and nothing else", () => {
    expect(parseRequest('{"op":"start"}')).toEqual({ op: "start" });
    expect(parseRequest('{"op":"status"}')).toEqual({ op: "status" });
    expect(parseRequest('{"op":"logout"}')).toEqual({ op: "logout" });
    expect(parseRequest('{"op":"finish","session":"s1","code":"abc"}')).toEqual({ op: "finish", session: "s1", code: "abc" });
    expect(parseRequest('{"op":"dispose","session":"s1"}')).toEqual({ op: "dispose", session: "s1" });
    for (const bad of ["", "nope", "[]", '{"op":"rm"}', '{"op":"finish","session":"s1"}', '{"op":"finish","code":"x"}', `{"op":"finish","session":"s","code":"${"x".repeat(3000)}"}`]) {
      expect(parseRequest(bad)).toBeUndefined();
    }
  });
});

describe("the agy helper", () => {
  it("start opens a session, finish passes the code to the adapter once with its state, and a success closes the session", async () => {
    const a = realAdapter();
    const h = createAgyHelper(a);
    const s = await h.handle({ op: "start" });
    expect(s).toMatchObject({ ok: true, op: "start", html: "open the link" });
    const session = (s as { session: string }).session;
    expect(h.sessions()).toBe(1);
    const f = await h.handle({ op: "finish", session, code: CODE });
    expect(a.finish).toHaveBeenCalledWith("default", CODE, { child: 1 });
    expect(f).toEqual({ ok: true, op: "finish", finished: { ok: true, html: "signed in" } });
    expect(h.sessions()).toBe(0);
    expect(a.disposed).toHaveBeenCalled();
  });

  it("a failed paste keeps the session for a retry; an ended attempt closes it", async () => {
    let n = 0;
    const a = realAdapter({ finish: vi.fn(async () => (++n === 1 ? { ok: false, html: "typo" } : { ok: false, ended: true, html: "agy gave up" })) });
    const h = createAgyHelper(a);
    const session = ((await h.handle({ op: "start" })) as { session: string }).session;
    await h.handle({ op: "finish", session, code: "x" });
    expect(h.sessions()).toBe(1);
    const second = await h.handle({ op: "finish", session, code: "y" });
    expect(second).toMatchObject({ finished: { ok: false, ended: true } });
    expect(h.sessions()).toBe(0);
  });

  it("an unknown or expired session is an ended attempt, never a call into the adapter", async () => {
    const a = realAdapter();
    let t = 0;
    const h = createAgyHelper(a, () => t);
    const stale = await h.handle({ op: "finish", session: "nope", code: CODE });
    expect(stale).toMatchObject({ ok: true, finished: { ok: false, ended: true } });
    const session = ((await h.handle({ op: "start" })) as { session: string }).session;
    t += 11 * 60_000;
    const late = await h.handle({ op: "finish", session, code: CODE });
    expect(late).toMatchObject({ finished: { ok: false, ended: true } });
    expect(a.finish).not.toHaveBeenCalled();
    expect(a.disposed).toHaveBeenCalled();
  });

  it("a second start replaces the first login and disposes it", async () => {
    const a = realAdapter();
    const h = createAgyHelper(a);
    await h.handle({ op: "start" });
    await h.handle({ op: "start" });
    expect(h.sessions()).toBe(1);
    expect(a.disposed).toHaveBeenCalledTimes(1);
  });

  it("logout drops a waiting login first, so its code cannot sign back in, then answers with the adapter's proof", async () => {
    const a = realAdapter();
    const h = createAgyHelper(a);
    const session = ((await h.handle({ op: "start" })) as { session: string }).session;
    const out = await h.handle({ op: "logout" });
    expect(out).toEqual({ ok: true, op: "logout", finished: { ok: true, html: "signed out" } });
    expect(h.sessions()).toBe(0);
    const late = await h.handle({ op: "finish", session, code: CODE });
    expect(late).toMatchObject({ finished: { ended: true } });
    expect(a.finish).not.toHaveBeenCalled();
  });

  it("an adapter that throws becomes an error response, not a crash, and the message carries no code", async () => {
    const a = realAdapter({ start: vi.fn(async () => { throw new Error("agy is not installed"); }) });
    const res = await createAgyHelper(a).handle({ op: "start" });
    expect(res).toEqual({ ok: false, error: "agy is not installed" });
  });

  it("status returns the adapter's rows", async () => {
    expect(await createAgyHelper(realAdapter()).handle({ op: "status" })).toMatchObject({ ok: true, op: "status", rows: [{ ok: true }] });
  });
});

// ── the bot side, against the helper over a REAL unix socket ──────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function serveHelper(adapter: LoginAdapter): Promise<{ path: string; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "agy-sock-"));
  dirs.push(dir);
  const path = join(dir, "s.sock");
  const helper = createAgyHelper(adapter);
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = parseRequest(buf.slice(0, nl));
      void (req ? helper.handle(req) : Promise.resolve<AgyResponse>({ ok: false, error: "unknown request" })).then((r) => sock.end(`${JSON.stringify(r)}\n`));
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, close: () => server.close() };
}

describe("the bot-side adapter", () => {
  it("start → finish → logout → status all work over a real unix socket, and the code reaches the helper's adapter", async () => {
    const real = realAdapter();
    const srv = await serveHelper(real);
    try {
      const a = createAgyRemoteAdapter(realAdapter({ start: vi.fn(async () => { throw new Error("local must not run"); }) }), { socketPath: srv.path });
      const s = await a.start("default");
      expect(s.html).toBe("open the link");
      const f = await a.finish("default", CODE, s.state);
      expect(f).toEqual({ ok: true, html: "signed in" });
      expect(real.finish).toHaveBeenCalledWith("default", CODE, { child: 1 });
      expect(await a.logout!("default")).toEqual({ ok: true, html: "signed out" });
      expect(await a.status()).toMatchObject([{ ok: true, detail: "works" }]);
    } finally {
      srv.close();
    }
  });

  it("dispose on the bot's attempt closes the helper's session", async () => {
    const real = realAdapter();
    const srv = await serveHelper(real);
    try {
      const a = createAgyRemoteAdapter(realAdapter(), { socketPath: srv.path });
      const s = await a.start("default");
      await s.dispose?.();
      expect(real.disposed).toHaveBeenCalled();
    } finally {
      srv.close();
    }
  });

  it("with no socket every call goes to the local adapter, as before", async () => {
    const local = realAdapter();
    const a = createAgyRemoteAdapter(local, { socketPath: "/nonexistent.sock", socketExists: () => false });
    await a.start("default");
    await a.finish("default", CODE, undefined);
    await a.logout!("default");
    await a.status();
    expect(local.start).toHaveBeenCalled();
    expect(local.finish).toHaveBeenCalled();
    expect(local.logout).toHaveBeenCalled();
  });

  it("a dead socket: start throws with the by-hand steps, finish ends the attempt, logout and status say it is unreachable, none claims success", async () => {
    const request = vi.fn(async (): Promise<AgyResponse> => ({ ok: false, error: "cannot reach the agy helper: ECONNREFUSED" }));
    const a = createAgyRemoteAdapter(realAdapter(), { socketPath: "/run/x.sock", socketExists: () => true, request });
    await expect(a.start("default")).rejects.toThrow(/ECONNREFUSED.*ssh -t founderos-vps/s);
    expect(await a.finish("default", CODE, { session: "s" })).toMatchObject({ ok: false, ended: true });
    expect(await a.logout!("default")).toMatchObject({ ok: false });
    expect((await a.status())[0]).toMatchObject({ ok: false });
  });

  it("socketRequest: a missing socket resolves to an error instead of throwing", async () => {
    const res = await socketRequest("/definitely/not/here.sock", { op: "status" } as AgyRequest, 1000);
    expect(res).toMatchObject({ ok: false });
  });
});
