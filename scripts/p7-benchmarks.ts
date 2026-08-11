import { env } from "../src/core/config.js";
import { getKernel } from "../src/gateway/kernel-boot.js";
import { getBot, registerHandlers } from "../src/gateway/telegram.js";
import { closeDatabaseConnections } from "../src/db/client.js";

const tasks = [
  "What jobs have been captured? Give me a CSV.",
  "Research Adyen and score them for outreach.",
  "Find the open GitHub issues on FounderOS and summarize what needs attention.",
  "What is the current FounderOS operational status?",
  "Draft a LinkedIn launch post for FounderOS based on what we've built.",
  "Research this company and prepare the information I'd need for outreach."
];

async function main() {
  await getKernel(); // Boot the P7 kernel
  const bot = getBot();
  await bot.init();
  registerHandlers(bot);
  
  for (const text of tasks) {
    console.log(`\n\n=== SENDING: ${text} ===\n`);
    
    let updateId = Math.floor(Math.random() * 1000000);
    await bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: parseInt(env.TELEGRAM_CHAT_ID), is_bot: false, first_name: "Founder" },
        chat: { id: parseInt(env.TELEGRAM_CHAT_ID), type: "private", first_name: "Founder" },
        date: Math.floor(Date.now() / 1000),
        text: text,
      }
    });
    
    // Wait for the turn to complete
    console.log("Waiting 30s for completion...");
    await new Promise(r => setTimeout(r, 30000));
  }
  
  await closeDatabaseConnections();
}

main().catch(console.error);
