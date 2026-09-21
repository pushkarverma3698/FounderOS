const fs = require('fs');
const content = fs.readFileSync('src/gateway/telegram.ts', 'utf-8');
const newContent = content
  .replace('import { handleAsk, handleDraft, handleApplied } from "./jobhunt-commands.js";', 'import { handleAsk, handleDraft, handleApplied, handleSubmit } from "./jobhunt-commands.js";')
  .replace('bot.command("draft", (ctx: Context) => handleDraft(ctx, { runKernelText }));', 'bot.command("draft", (ctx: Context) => handleDraft(ctx, { runKernelText }));\n  bot.command("submit", (ctx: Context) => handleSubmit(ctx, { runKernelText }));')
  .replace('bot.command("wife_draft", (ctx: Context) => handleDraft(withForcedProfileToken(ctx, "wife"), { runKernelText }));', 'bot.command("wife_draft", (ctx: Context) => handleDraft(withForcedProfileToken(ctx, "wife"), { runKernelText }));\n  bot.command("wife_submit", (ctx: Context) => handleSubmit(withForcedProfileToken(ctx, "wife"), { runKernelText }));');
fs.writeFileSync('src/gateway/telegram.ts', newContent);
