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
  /** The attempt cannot take another paste (its child is gone). With !ok the command drops it instead of leaving it open. */
  readonly ended?: boolean;
  /** A follow-up step (another link): it replaces the finished attempt, and the next paste goes to it. Only with ok. */
  readonly next?: LoginStarted;
}

export interface LoginTargetStatus {
  readonly target: string;
  /** Short human label, e.g. "Pushkar (personal)". */
  readonly label: string;
  readonly ok: boolean;
  /** Nothing failed, but no live check ran either: shown as ❔, never ✅. */
  readonly unverified?: boolean;
  /** One line: "signed in as x@y" / "refresh token revoked" / "never signed in". */
  readonly detail: string;
}

export interface LoginAdapter {
  /** Lowercase letters, used as `/login <id> [target]`. */
  readonly id: string;
  /** Shown on the status screen. */
  readonly title: string;
  /** What `/login <id> <target>` accepts. A single-target tool lists ["default"]. Read fresh on every command (may be a getter). */
  readonly targets: readonly string[];
  /** Optional: `/login <id> add <name>` signs a NEW target in under that name. Returns why the name is refused, or undefined. */
  addProblem?(name: string): string | undefined;
  /** Optional: `/login <id> remove <name>` signs a target out and forgets it. */
  remove?(target: string): Promise<LoginFinished>;
  /** Optional: `/login <id> <email>` is accepted and handed to `start` as `hint`, to pre-select that account on the sign-in page. */
  readonly acceptsEmailHint?: boolean;
  start(target: string, hint?: string): Promise<LoginStarted>;
  finish(target: string, pasted: string, state: unknown): Promise<LoginFinished>;
  /** One cheap live check per target; powers the `/login` screen. Must not throw. */
  status(): Promise<readonly LoginTargetStatus[]>;
}
