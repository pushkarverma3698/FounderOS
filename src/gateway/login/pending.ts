/**
 * One in-flight login per chat, in memory. Lost on restart on purpose: a code is single-use and
 * expires in minutes, and a Claude login holds a live child process that cannot be persisted.
 */

import type { LoginAdapter, LoginStarted } from "./types.js";

export const LOGIN_TTL_MS = 10 * 60_000;

interface Pending {
  readonly adapter: LoginAdapter;
  readonly target: string;
  readonly started: LoginStarted;
  readonly expiresAt: number;
}

export class PendingLogins {
  private readonly byChat = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Replaces (and disposes) any earlier attempt in the same chat. */
  async begin(chatId: string, adapter: LoginAdapter, target: string, started: LoginStarted): Promise<void> {
    await this.drop(chatId);
    this.byChat.set(chatId, { adapter, target, started, expiresAt: this.now() + LOGIN_TTL_MS });
  }

  /** The live attempt for this chat, or undefined (an expired one is disposed and forgotten). */
  async peek(chatId: string): Promise<Pending | undefined> {
    const p = this.byChat.get(chatId);
    if (!p) return undefined;
    if (p.expiresAt <= this.now()) {
      await this.drop(chatId);
      return undefined;
    }
    return p;
  }

  async drop(chatId: string): Promise<void> {
    const p = this.byChat.get(chatId);
    if (!p) return;
    this.byChat.delete(chatId);
    // allow-failopen: disposing a dead child process must not block the next login attempt.
    await Promise.resolve(p.started.dispose?.()).catch(() => undefined);
  }
}
