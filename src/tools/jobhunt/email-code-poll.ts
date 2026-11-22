/**
 * Polls Gmail (read-only, via the googleapis provider, ADR-029) for the emailed security code of a held apply form
 * and hands a single unambiguous code to `enter`. The Telegram prompt is already out, so every non-success path
 * (nothing found, two codes, errors, hold released) just stops and the founder types the code as before.
 * Logs carry the row id, the sender domain and found / not found only: never the code or any mail text.
 */

import { directReadEmails } from "../../infra/providers/google-direct.js";
import { childLogger } from "../../infra/logger.js";
import { parseEmailList, scanEmailCodes, type CodeMail } from "./email-code.js";

const log = childLogger({ module: "jobhunt:email-code-poll" });

export const EMAIL_POLL_MS = 15_000;
export const EMAIL_POLL_MAX_MS = 8 * 60_000;
export const EMAIL_CODE_QUERY = "newer_than:15m";

export interface PollInput {
  readonly rowId: string;
  readonly company: string;
  /** Epoch ms of the Submit click; older mail is stale. */
  readonly sentAfter: number;
}

export interface PollDeps {
  /** Recent mail, or null when the read failed (polling goes on). */
  readonly read: () => Promise<readonly CodeMail[] | null>;
  /** False once the hold was released or expired. */
  readonly isHeld: () => boolean;
  /** Enters the code through the existing submit-and-confirm path. */
  readonly enter: (code: string) => Promise<void>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export type PollOutcome = "entered" | "not-found" | "ambiguous" | "released" | "error";

export async function pollEmailCode(input: PollInput, deps: PollDeps): Promise<PollOutcome> {
  const { rowId } = input;
  const start = deps.now();
  while (deps.now() - start < EMAIL_POLL_MAX_MS) {
    if (!deps.isHeld()) return "released";
    const mails = await deps.read();
    if (mails) {
      const scan = scanEmailCodes(mails, { company: input.company, sentAfter: input.sentAfter });
      if (scan.codes.length > 1) {
        log.info({ rowId, found: false, reason: "ambiguous", domains: scan.domains }, "email code: more than one code, leaving it to the founder");
        return "ambiguous";
      }
      if (scan.codes.length === 1) {
        if (!deps.isHeld()) return "released";
        log.info({ rowId, found: true, domains: scan.domains }, "email code: found, entering it");
        try {
          await deps.enter(scan.codes[0]!);
          return "entered";
        } catch (err) {
          // allow-failopen: the Telegram prompt is already out, so a failed auto-entry leaves the founder's manual path.
          log.warn({ rowId, err: (err as Error).message }, "email code: entering the code failed");
          return "error";
        }
      }
    }
    await deps.sleep(EMAIL_POLL_MS);
  }
  log.info({ rowId, found: false, reason: "timeout" }, "email code: not found in time, leaving it to the founder");
  return "not-found";
}

/** The real reader: Gmail via the provider, parsed to mails. Failures read as null. */
export async function readRecentMail(accountKey?: string): Promise<readonly CodeMail[] | null> {
  const res = await directReadEmails({ query: EMAIL_CODE_QUERY, max_results: 10, ...(accountKey ? { account_key: accountKey } : {}) });
  if (!res.success || typeof res.data !== "string") return null;
  return parseEmailList(res.data);
}
