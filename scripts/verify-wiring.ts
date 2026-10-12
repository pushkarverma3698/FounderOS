/**
 * FounderOS — Wiring Verification CLI (compile/CI-time gate)
 * =========================================================
 * Fails the build when the jobs process is half-wired (2026-10-10, replaces the tool-registry check):
 *   - a ☰ menu command with no handler, or a registered handler missing from the menu;
 *   - a jobs cron whose expression node-cron rejects (it would throw at boot, after the deploy went green).
 *
 *   pnpm verify:wiring
 *
 * Offline & keyless: importing the bot pulls config.ts (Zod env validation), so we inject the
 * SAME safe stubs the test harness uses (tests/setup.ts) for any unset var. Real values win.
 */

process.env["NODE_ENV"] ||= "test";
process.env["DATABASE_URL"] ||= "postgresql://test:test@localhost:5432/founderos_test";
process.env["TELEGRAM_BOT_TOKEN"] ||= "1234567890:verify_wiring_stub_token";
process.env["TELEGRAM_CHAT_ID"] ||= "-1001234567890";
process.env["LOG_LEVEL"] ||= "error";

async function main(): Promise<void> {
  const cron = (await import("node-cron")).default;
  const { registerJobsHandlers } = await import("../src/jobs/bot.js");
  const { JOBS_CRONS } = await import("../src/jobs/scheduler.js");
  const { COMMAND_MENU } = await import("../src/gateway/command-menu.js");
  const { buildChatAccessConfig } = await import("../src/gateway/chat-access.js");

  const registered: string[] = [];
  const noop = () => undefined;
  registerJobsHandlers(
    { use: noop, on: noop, catch: noop, command: (name: string) => registered.push(name) } as never,
    buildChatAccessConfig({ primaryChatId: "1", allowedChatIds: "", answerAllChatIds: "", ownerUserId: undefined }),
  );

  const errors: string[] = [];
  const menu = new Set(COMMAND_MENU.map((e) => e.command));
  for (const c of registered) if (!menu.has(c)) errors.push(`/${c} has a handler but is not in COMMAND_MENU (command-menu.ts).`);
  for (const c of menu) if (!registered.includes(c)) errors.push(`/${c} is in COMMAND_MENU but no handler is registered (jobs/bot.ts).`);
  for (const job of JOBS_CRONS) if (!cron.validate(job.expr)) errors.push(`Cron "${job.name}" has an invalid expression: ${job.expr}`);

  if (errors.length > 0) {
    for (const e of errors) console.error(`❌ ${e}`);
    console.error(`\nWiring check FAILED: ${errors.length} error(s).`);
    process.exit(1);
  }
  console.log(`✅ Wiring check passed — ${registered.length} commands match the menu, ${JOBS_CRONS.length} crons valid.`);
}

main().catch((err) => {
  console.error("Wiring check crashed:", err);
  process.exit(1);
});
