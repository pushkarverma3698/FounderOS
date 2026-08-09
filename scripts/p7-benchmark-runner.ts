import { env } from "../src/core/config.js";
import { getKernel } from "../src/gateway/kernel-boot.js";
import { getBot, registerHandlers } from "../src/gateway/telegram.js";
import { closeDatabaseConnections } from "../src/db/client.js";

async function main() {
  await getKernel(); // Boot the P7 kernel
  const bot = getBot();
  await bot.init();
  registerHandlers(bot);
  
  const text = process.argv[2] || "What jobs have been captured? Give me a CSV.";
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
  
  // Keep the process alive for a while to let async work finish
  console.log("Update injected. Waiting 60s for completion...");
  await new Promise(r => setTimeout(r, 60000));
  await closeDatabaseConnections();
}

main().catch(console.error);
