/**
 * /questions and /wife_questions: how many unanswered form questions block how many roles, and a web_app
 * button to the answer-bank page. The button follows the profile editor's rules (private chat, https base, the
 * person whose profile it is); without it the reply lists the top questions so the count is never a dead end.
 */

import { InlineKeyboard, type Context } from "grammy";
import { readApplyLinkConfig } from "../tools/jobhunt/apply-link.js";
import { summaryLine } from "../tools/jobhunt/open-questions.js";
import { escapeHtml } from "./apply-page.js";
import { opensInTelegram } from "./apply-flow.js";
import { isProfileArgMiss, profileMissMessage, resolveProfileArg } from "./jobhunt-profile-arg.js";
import { profileForUser } from "./miniapp-auth.js";
import { openQuestionsFor, type QuestionsDeps } from "./questions-data.js";

const TEXT_LIST = 10;

function questionsKeyboard(ctx: Context, profileId: string): InlineKeyboard | null {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return null;
  const cfg = readApplyLinkConfig(process.env);
  if (!cfg.ok) return null;
  const url = `${cfg.baseUrl}/apply/questions`;
  if (!opensInTelegram(String(chatId), url) || profileForUser(userId, process.env) !== profileId) return null;
  return new InlineKeyboard().webApp("Answer questions", url);
}

export async function handleQuestions(ctx: Context, deps?: QuestionsDeps): Promise<void> {
  const arg = resolveProfileArg(ctx.match?.toString() ?? "", []);
  if (isProfileArgMiss(arg)) {
    await ctx.reply(escapeHtml(profileMissMessage(arg)));
    return;
  }
  const open = await openQuestionsFor(arg.profile.id, new Date(), deps);
  const who = arg.explicit ? `${arg.profile.candidateName}: ` : "";
  const head = `${who}${summaryLine(open)} (last 14 days).`;
  const profileNote = open.profileFields.length > 0 ? `\n${open.profileFields.length} more are eligibility or self-identification: answer those in /profile.` : "";
  if (open.questions.length === 0) {
    await ctx.reply(escapeHtml(head + profileNote), { parse_mode: "HTML" });
    return;
  }
  const kb = questionsKeyboard(ctx, arg.profile.id);
  if (kb) {
    await ctx.reply(escapeHtml(head + profileNote), { parse_mode: "HTML", reply_markup: kb });
    return;
  }
  const lines = open.questions.slice(0, TEXT_LIST).map((q) => `• ${escapeHtml(q.label)} (${q.roles})`);
  await ctx.reply(`${escapeHtml(head + profileNote)}\n\n${lines.join("\n")}\n\nOpen /questions in a private chat to answer them in one sitting.`, { parse_mode: "HTML" });
}
