import { env } from "../src/core/config.js";
import { getKernel } from "../src/gateway/kernel-boot.js";
import { getBot, registerHandlers } from "../src/gateway/telegram.js";
import { closeDatabaseConnections } from "../src/db/client.js";
import { EventEmitter } from "node:events";

// We will capture logs by monkeypatching process.stdout.write
const logs: any[] = [];
const originalWrite = process.stdout.write;
process.stdout.write = function (chunk: any, encoding?: any, cb?: any): boolean {
  if (typeof chunk === "string") {
    try {
      const obj = JSON.parse(chunk);
      if (obj.module === "trace") {
        logs.push(obj);
      }
    } catch {}
  }
  // @ts-ignore
  return originalWrite.apply(process.stdout, arguments);
};

const tasks = [
  "What jobs have been captured? Give me a CSV.",
  "Research Adyen and score them for outreach.",
  "Find the open GitHub issues on FounderOS and summarize what needs attention.",
  "What is the current FounderOS operational status?",
  "Draft a LinkedIn launch post for FounderOS based on what we've built.",
  "Research this company and prepare the information I'd need for outreach."
];

async function main() {
  await getKernel(); 
  const bot = getBot();
  await bot.init();
  registerHandlers(bot);
  
  for (let i = 0; i < tasks.length; i++) {
    const text = tasks[i];
    console.warn(`\n\n=== RUNNING BENCHMARK ${i+1}/${tasks.length}: ${text} ===\n`);
    
    logs.length = 0; // clear logs
    
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
    
    // Wait until turn.out is logged
    let waitIters = 0;
    while (waitIters < 60) {
      if (logs.some(l => l.seam === "turn.out")) break;
      await new Promise(r => setTimeout(r, 1000));
      waitIters++;
    }
    
    // Analyze logs
    const toolCalls = logs.filter(l => l.seam === "tool.call").map(l => l.data.tool);
    const retrievalCalls = toolCalls.filter(t => t.includes("search") || t.includes("rag"));
    const turnOut = logs.find(l => l.seam === "turn.out");
    const turnProgress = logs.find(l => l.seam === "turn.progress");
    
    console.warn(`RESULT FOR "${text}":`);
    console.warn(`- Worker Assigned: ${turnProgress ? turnProgress.data.label.split(":")[0].replace("🔧 ", "") : "N/A"}`);
    console.warn(`- Tool Calls (${toolCalls.length}): ${toolCalls.join(", ")}`);
    console.warn(`- Retrieval Calls (${retrievalCalls.length}): ${retrievalCalls.join(", ")}`);
    console.warn(`- Status: ${turnOut ? turnOut.data.replyPreview : "TIMEOUT"}`);
    console.warn("------------------------------------------------------------------");
  }
  
  await closeDatabaseConnections();
}

main().catch(console.error);
