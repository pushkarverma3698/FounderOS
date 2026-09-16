/**
 * One-prompt MTProto probe — what does the founder ACTUALLY receive?
 * ==================================================================
 * Sends a single message as the founder through the real Telegram transport and
 * prints every reply the bot sends back, with the wall-clock latency of each.
 *
 * WHY THIS EXISTS. The repo already had `e2e-telegram-qa.ts` (22 tasks) and
 * `e2e-hard-battery.ts` (34) — both milestone gates that cost real Gemini tokens
 * and minutes. Neither is usable for the thing CLAUDE.md actually requires after
 * every gateway fix: "drive it through Telegram before calling it done." So that
 * step kept being skipped, or approximated by calling a tool's .execute() over
 * SSH — which proves the tool and proves nothing about the planner, the prompt,
 * or the reply the founder sees. That gap is exactly where the 2026-09-06/07
 * defects lived, and where the 2026-09-16 five-minute timeout lived: every
 * unit test was green while the founder got nothing.
 *
 * Latency is printed per reply because a turn that "works" at 300s is a turn the
 * founder has already walked away from. Silence is a result too: zero replies is
 * reported as a FAILURE with the elapsed wait, never as a clean exit.
 *
 * Requires TELEGRAM_TESTER_API_ID / _API_HASH / _SESSION (see
 * `scripts/telegram-tester.ts login`). Costs one real turn of model spend, so it
 * belongs in the live-verification zone — after the unit tests are green, not
 * during the loop (CLAUDE.md § "Zero paid calls in the dev loop").
 *
 *   node --import tsx/esm --env-file=.env scripts/telegram-probe.ts "your prompt" [waitSeconds]
 */

import { connect, botUsername, sleep, POLL_INTERVAL_MS, assertMtprotoConfigured } from "./lib/mtproto.js";

const DEFAULT_WAIT_S = 360;

/**
 * Progress chatter the gateway streams while a turn runs (kernel-progress.ts).
 * These are NOT the answer, and counting one as the answer is a false green:
 * the first run of this probe reported "OK, 1 reply in 9s" for a turn that
 * actually took 200s, because "🤔 Working on it…" arrived and the collector
 * went quiet. A probe that exists to catch false greens must not emit one.
 */
const TRANSIENT_PREFIXES = ["🤔", "🔧", "✍️", "🔍", "📋", "⏳"];

const isTransient = (text: string): boolean => {
  const t = text.trimStart();
  return t.length === 0 || TRANSIENT_PREFIXES.some((p) => t.startsWith(p));
};

async function main(): Promise<void> {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error('usage: telegram-probe.ts "<prompt>" [waitSeconds]');
    process.exit(1);
  }
  const waitS = Number(process.argv[3] ?? DEFAULT_WAIT_S);

  assertMtprotoConfigured();
  const peer = await botUsername();
  const client = await connect();

  console.log(`→ as founder, to @${peer} (waiting up to ${waitS}s)\n   ${prompt}\n`);
  const startedAt = Date.now();
  const sent = await client.sendMessage(peer, { message: prompt });

  // Own poll loop rather than the shared sendAndCollect: that helper treats a
  // progress placeholder as a reply and stops as soon as the bot goes quiet,
  // which ends the probe seconds into a turn that is still running.
  const deadline = startedAt + waitS * 1_000;
  const seen = new Set<number>();
  const answers: string[] = [];

  while (Date.now() < deadline && answers.length === 0) {
    await sleep(POLL_INTERVAL_MS);
    for (const msg of await client.getMessages(peer, { limit: 20 })) {
      const text = String(msg.message ?? "");
      if (msg.id <= sent.id || msg.out || seen.has(msg.id)) continue;
      seen.add(msg.id);
      if (isTransient(text)) {
        console.log(`   · ${text.trim().slice(0, 70)}`);
        continue;
      }
      answers.push(text);
    }
  }

  const elapsedS = Math.round((Date.now() - startedAt) / 1000);
  await client.disconnect();

  for (const [i, text] of answers.entries()) {
    console.log(`\n── reply ${i + 1} ──────────────────────────────────────────`);
    console.log(text.trim() || "(no text — media or buttons only)");
  }

  // Silence is the failure this probe exists to catch, so it must never look
  // like a pass: the 2026-09-16 turn printed nothing and died at 300s.
  if (answers.length === 0) {
    console.error(`\nFAILED: no substantive reply in ${elapsedS}s. The founder received NOTHING.`);
    process.exit(1);
  }
  console.log(`\nOK: ${answers.length} reply/replies, first answer at ${elapsedS}s.`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
