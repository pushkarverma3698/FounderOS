import { type Context } from "grammy";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../infra/logger.js";
import { sendToChat } from "./telegram.js";

const execAsync = promisify(exec);
const log = logger.child({ module: "pr-callbacks" });

export async function handlePrCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  
  if (data.startsWith("pr_merge:")) {
    const [, repo, prNum] = data.split(":");
    await ctx.answerCallbackQuery({ text: `Merging ${repo}#${prNum}...` });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {}
    
    try {
      // Execute gh pr merge
      const cmd = `gh pr merge ${prNum} --repo ${repo} --merge --delete-branch`;
      log.info({ cmd }, "Executing PR merge");
      const { stdout, stderr } = await execAsync(cmd);
      await sendToChat(`✅ <b>Merged ${repo}#${prNum}</b>\n<code>${stdout || stderr}</code>`);
    } catch (e: any) {
      log.error({ err: e }, "Failed to merge PR");
      await sendToChat(`❌ <b>Failed to merge ${repo}#${prNum}</b>\n<code>${e.message}</code>`);
    }
    return true;
  }
  
  if (data.startsWith("pr_fix:")) {
    const [, repo, prNum] = data.split(":");
    await ctx.answerCallbackQuery({ text: `Triggering Auto-Fix for ${repo}#${prNum}...` });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {}
    
    try {
      // Execute agent-dispatch for this PR right now
      const cmd = `~/bin/agent-dispatch`;
      log.info({ cmd }, "Triggering agent-dispatch");
      // we just run the loop immediately in background. It will pick up the PR.
      exec(cmd);
      await sendToChat(`🔄 <b>Auto-Fix triggered for ${repo}#${prNum}</b>\nagent-dispatch has been kicked to pick up the PR immediately.`);
    } catch (e: any) {
      log.error({ err: e }, "Failed to trigger auto fix");
    }
    return true;
  }

  return false;
}
