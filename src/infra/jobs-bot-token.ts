/**
 * Which Telegram bot the jobs process speaks as.
 *
 * JOBS_BOT_TOKEN is the jobs bot the founder creates in @BotFather. Until it is
 * set, the process falls back to TELEGRAM_BOT_TOKEN (the old FounderOS bot) so a
 * deploy never leaves the jobs group silent. The source is logged at boot.
 */
export type JobsBotTokenSource = "JOBS_BOT_TOKEN" | "TELEGRAM_BOT_TOKEN";

export function resolveJobsBotToken(
  vars: Readonly<Record<string, string | undefined>> = process.env,
): { readonly token: string; readonly source: JobsBotTokenSource } {
  const jobs = vars["JOBS_BOT_TOKEN"]?.trim();
  if (jobs) return { token: jobs, source: "JOBS_BOT_TOKEN" };
  const legacy = vars["TELEGRAM_BOT_TOKEN"]?.trim();
  if (legacy) return { token: legacy, source: "TELEGRAM_BOT_TOKEN" };
  throw new Error("No bot token: set JOBS_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) in .env");
}
