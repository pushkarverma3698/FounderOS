/**
 * FounderOS — /login adapter contract
 * ===================================
 * One flow for every credential the founder has to renew by hand: start → he opens a
 * link on his phone → he pastes back a code or URL → finish stores it and tests it.
 * A new tool (Google account, Claude Code, agy, whatever replaces them) is ONE adapter
 * file in `adapters/` plus one line in `registry.ts`; the command, the pending-reply
 * interception and the status screen are shared.
 *
 * Rules every adapter keeps:
 *   - never log, return or echo a secret (code, token, refresh token); `html` is shown to him;
 *   - `finish` proves the credential works with one cheap real call before it says ok;
 *   - `start` and `finish` never throw for an expected failure: return `{ ok:false, html }`.
 */

export interface LoginStarted {
  /** Telegram HTML sent to the founder: the link and what to paste back. */
  readonly html: string;
  /** Anything `finish` needs (PKCE verifier, a live child process). Held in memory only. */
  readonly state?: unknown;
  /** Called when the attempt is replaced, expires, or finishes. Kill child processes here. */
  readonly dispose?: () => void | Promise<void>;
}

export interface LoginFinished {
  readonly ok: boolean;
  /** Telegram HTML: what was stored and verified, or exactly what failed and what to do. */
  readonly html: string;
}

export interface LoginTargetStatus {
  readonly target: string;
  /** Short human label, e.g. "Pushkar (personal)". */
  readonly label: string;
  readonly ok: boolean;
  /** One line: "signed in as x@y" / "refresh token revoked" / "never signed in". */
  readonly detail: string;
}

export interface LoginAdapter {
  /** Lowercase letters, used as `/login <id> [target]`. */
  readonly id: string;
  /** Shown on the status screen. */
  readonly title: string;
  /** What `/login <id> <target>` accepts. A single-target tool lists ["default"]. */
  readonly targets: readonly string[];
  start(target: string): Promise<LoginStarted>;
  finish(target: string, pasted: string, state: unknown): Promise<LoginFinished>;
  /** One cheap live check per target; powers the `/login` screen. Must not throw. */
  status(): Promise<readonly LoginTargetStatus[]>;
}
