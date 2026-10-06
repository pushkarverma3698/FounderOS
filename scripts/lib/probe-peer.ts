/**
 * Where a live probe posts (UX audit P2-8: test messages stay off the real chat).
 *
 * Default is the bot's own chat, as before. Set TELEGRAM_TEST_CHAT_ID to a group the
 * bot and the tester account are both in (and add it to TELEGRAM_ANSWER_ALL_CHAT_IDS
 * on the box) and every probe posts there. A test chat that is also one of the real
 * chats defeats the point, so it is refused.
 */

export type ProbePeer = string | number;

const REAL_CHAT_VARS = ["TELEGRAM_CHAT_ID", "JOBHUNT_CHAT_ID"] as const;

export function probePeerFor(botUsername: string, env: Record<string, string | undefined>): ProbePeer {
  const test = env["TELEGRAM_TEST_CHAT_ID"]?.trim();
  if (!test) return botUsername;
  for (const name of REAL_CHAT_VARS) {
    if (env[name]?.trim() === test) {
      throw new Error(`TELEGRAM_TEST_CHAT_ID equals ${name}: a test chat must not be a real one.`);
    }
  }
  return /^-?\d+$/.test(test) ? Number(test) : test;
}
