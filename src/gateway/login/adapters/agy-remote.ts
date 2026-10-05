/**
 * /login agy from the bot: forwards to the agy login helper (agy-helper.ts) over its unix socket.
 *
 * The bot cannot run agy itself (agy is installed for `antigravity` only, and the bot's unit has NoNewPrivileges, so
 * sudo fails). The helper runs as `antigravity`; this adapter only relays the founder's pasted code and shows the
 * answers. When the socket is not there (a laptop, or the unit not installed yet) every call falls through to the
 * local adapter, which behaves exactly as before: runs agy as the bot's own user, or says how to do it by hand.
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import { childLogger } from "../../../infra/logger.js";
import { DEFAULT_AGY_SOCKET, type AgyRequest, type AgyResponse } from "../agy-protocol.js";
import type { LoginAdapter, LoginFinished, LoginStarted, LoginTargetStatus } from "../types.js";
import { SSH_HINT } from "./agy.js";

const log = childLogger({ module: "gateway:login:agy-remote" });

const REQUEST_TIMEOUT_MS = 150_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface AgyRemoteDeps {
  readonly socketPath: string;
  readonly socketExists: (path: string) => boolean;
  readonly request: (path: string, req: AgyRequest) => Promise<AgyResponse>;
}

export function socketRequest(path: string, req: AgyRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<AgyResponse> {
  return new Promise((resolve) => {
    const fail = (error: string): void => resolve({ ok: false, error });
    const sock = connect(path);
    let buf = "";
    let settled = false;
    const done = (res: AgyResponse): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(res);
    };
    sock.setTimeout(timeoutMs, () => done({ ok: false, error: "the agy helper did not answer in time" }));
    sock.on("error", (e) => done({ ok: false, error: `cannot reach the agy helper: ${(e as NodeJS.ErrnoException).code ?? e.message}` }));
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.length > MAX_RESPONSE_BYTES) return done({ ok: false, error: "the agy helper's answer was too large" });
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        done(JSON.parse(buf.slice(0, nl)) as AgyResponse);
      } catch {
        // allow-failopen: an unreadable answer is reported as a helper error, never treated as a success.
        done({ ok: false, error: "the agy helper's answer was not readable" });
      }
    });
    sock.on("end", () => {
      if (!settled) fail("the agy helper closed the connection without answering");
    });
  });
}

const unreachable = (error: string): LoginFinished => ({ ok: false, html: `Could not reach the agy helper (${error}).\n${SSH_HINT}` });

export function createAgyRemoteAdapter(local: LoginAdapter, overrides: Partial<AgyRemoteDeps> = {}): LoginAdapter {
  const d: AgyRemoteDeps = {
    socketPath: process.env["AGY_LOGIN_SOCKET"]?.trim() || DEFAULT_AGY_SOCKET,
    socketExists: existsSync,
    request: socketRequest,
    ...overrides,
  };
  const remote = (): boolean => d.socketExists(d.socketPath);

  return {
    ...local,
    id: local.id,
    title: local.title,
    targets: local.targets,

    async start(target, hint): Promise<LoginStarted> {
      if (!remote()) return local.start(target, hint);
      const res = await d.request(d.socketPath, { op: "start" });
      if (!res.ok || res.op !== "start") {
        log.warn({ error: res.ok ? "unexpected response" : res.error }, "agy helper start failed");
        throw new Error(`the agy helper did not start a login (${res.ok ? "unexpected response" : res.error}). ${SSH_HINT}`);
      }
      const session = res.session;
      return {
        html: res.html,
        state: { session },
        dispose: async () => void (await d.request(d.socketPath, { op: "dispose", session })),
      };
    },

    async finish(target, pasted, state): Promise<LoginFinished> {
      const session = (state as { session?: string } | undefined)?.session;
      if (!session) return local.finish(target, pasted, state);
      const res = await d.request(d.socketPath, { op: "finish", session, code: pasted });
      if (!res.ok || res.op !== "finish") return { ...unreachable(res.ok ? "unexpected response" : res.error), ended: true };
      return res.finished;
    },

    async logout(target): Promise<LoginFinished> {
      if (!remote()) return local.logout!(target);
      const res = await d.request(d.socketPath, { op: "logout" });
      if (!res.ok || res.op !== "logout") return unreachable(res.ok ? "unexpected response" : res.error);
      return res.finished;
    },

    async status(): Promise<readonly LoginTargetStatus[]> {
      if (!remote()) return local.status();
      const res = await d.request(d.socketPath, { op: "status" });
      if (res.ok && res.op === "status") return res.rows;
      return [{ target: "default", label: "agy", ok: false, detail: `could not reach the agy helper — ${SSH_HINT}` }];
    },
  };
}
