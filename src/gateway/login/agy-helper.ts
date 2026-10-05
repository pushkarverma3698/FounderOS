/**
 * The agy login helper: the agy adapter, running as the user that owns agy, behind a unix socket.
 *
 * Why it exists: agy is installed only for `antigravity` (home mode 750), and the bot's systemd unit sets
 * NoNewPrivileges, so the bot can neither run agy nor sudo to the user that can. This process is started by
 * systemd socket activation (deploy/systemd/agy-login.socket) as `antigravity`. The socket is 0660
 * antigravity:founderos, so the bot can ask it to start a login, hand over the pasted code, check the login
 * and sign out, and nothing else can. It reuses `createAgyAdapter` unchanged, with no sudo prefix, so the
 * scratch-HOME proof and the install-then-verify steps are the same code the bot used to run itself.
 *
 * It exits after IDLE_EXIT_MS with no login in flight; the next connection starts it again.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { childLogger } from "../../infra/logger.js";
import { createAgyAdapter } from "./adapters/agy.js";
import { DEFAULT_AGY_SOCKET, MAX_REQUEST_BYTES, parseRequest, type AgyRequest, type AgyResponse } from "./agy-protocol.js";
import { LOGIN_TTL_MS } from "./pending.js";
import type { LoginAdapter, LoginStarted } from "./types.js";

const log = childLogger({ module: "gateway:login:agy-helper" });

const IDLE_EXIT_MS = 20 * 60_000;
const CONNECTION_TIMEOUT_MS = 180_000;

interface Session {
  readonly started: LoginStarted;
  readonly expiresAt: number;
}

export interface AgyHelper {
  handle(req: AgyRequest): Promise<AgyResponse>;
  /** Logins waiting for a code. */
  sessions(): number;
}

export function createAgyHelper(adapter: LoginAdapter, now: () => number = Date.now): AgyHelper {
  const live = new Map<string, Session>();

  async function drop(id: string): Promise<void> {
    const s = live.get(id);
    if (!s) return;
    live.delete(id);
    // allow-failopen: disposing a dead child process must not block the next attempt.
    await Promise.resolve(s.started.dispose?.()).catch(() => undefined);
  }
  const dropAll = async (): Promise<void> => void (await Promise.all([...live.keys()].map(drop)));

  return {
    sessions: () => live.size,
    async handle(req): Promise<AgyResponse> {
      for (const [id, s] of live) if (s.expiresAt <= now()) await drop(id);
      try {
        switch (req.op) {
          case "start": {
            await dropAll(); // one login at a time: a second link replaces the first, as /login does in the bot
            const started = await adapter.start("default");
            const session = randomUUID();
            live.set(session, { started, expiresAt: now() + LOGIN_TTL_MS });
            return { ok: true, op: "start", html: started.html, session };
          }
          case "finish": {
            const s = live.get(req.session);
            if (!s) return { ok: true, op: "finish", finished: { ok: false, ended: true, html: "That sign-in attempt has ended. Send /login agy for a fresh link." } };
            const done = await adapter.finish("default", req.code, s.started.state);
            if (done.ok || done.ended) await drop(req.session);
            return { ok: true, op: "finish", finished: { ok: done.ok, html: done.html, ...(done.ended ? { ended: true } : {}) } };
          }
          case "dispose":
            await drop(req.session);
            return { ok: true, op: "dispose" };
          case "status":
            return { ok: true, op: "status", rows: await adapter.status() };
          case "logout": {
            await dropAll(); // a link waiting for a code must not complete a login after the sign-out
            const done = await adapter.logout!("default");
            return { ok: true, op: "logout", finished: { ok: done.ok, html: done.html } };
          }
        }
      } catch (err) {
        log.error({ op: req.op, err: err instanceof Error ? err.message : String(err) }, "agy helper request failed");
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function serve(server: Server, helper: AgyHelper, onActivity: () => void): void {
  server.on("connection", (socket: Socket) => {
    onActivity();
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
    let buf = "";
    let handled = false;
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buf += chunk.toString("utf8");
      if (buf.length > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(`${JSON.stringify({ ok: false, error: "request too large" } satisfies AgyResponse)}\n`);
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      const req = parseRequest(buf.slice(0, nl));
      const reply = req ? helper.handle(req) : Promise.resolve<AgyResponse>({ ok: false, error: "unknown request" });
      void reply.then((res) => {
        onActivity();
        socket.end(`${JSON.stringify(res)}\n`);
      });
    });
  });
}

function main(): void {
  const helper = createAgyHelper(createAgyAdapter());
  const server = createServer();
  let last = Date.now();
  serve(server, helper, () => void (last = Date.now()));

  const activated = process.env["LISTEN_FDS"] === "1" && process.env["LISTEN_PID"] === String(process.pid);
  if (activated) {
    server.listen({ fd: 3 });
  } else {
    const path = process.env["AGY_LOGIN_SOCKET"]?.trim() || DEFAULT_AGY_SOCKET;
    rmSync(path, { force: true });
    server.listen(path, () => chmodSync(path, 0o660));
  }
  server.on("listening", () => log.info({ activated }, "agy login helper listening"));
  setInterval(() => {
    if (helper.sessions() === 0 && Date.now() - last > IDLE_EXIT_MS) {
      log.info({}, "agy login helper idle, exiting");
      process.exit(0);
    }
  }, 60_000).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
