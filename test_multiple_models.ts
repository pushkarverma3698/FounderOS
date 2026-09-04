import { getModel } from './src/agents/model.js';

const modelsToTest = [
  "omnirouter:gh/Claude Sonnet 4.5",
  "omnirouter:cc/Claude 4.5 Sonnet",
  "omnirouter:antigravity/Claude Sonnet 4.6 (Thinking)",
  "omnirouter:gh/GPT-4o",
  "omnirouter:gh/GPT-4o mini",
  "omnirouter:antigravity/GPT-OSS 120B (Medium)",
  "omnirouter:gh/Gemini 3.1 Pro",
  "omnirouter:antigravity/Gemini 2.5 Flash",
];

async function main() {
  for (const modelId of modelsToTest) {
    console.log(`\nTesting ${modelId}...`);
    process.env.AGENT_MODEL = modelId;
    
    try {
      const model = getModel();
      const response = await model.invoke("Reply with exactly one word: 'Hello'.");
      console.log(`✅ Success: ${response.content}`);
    } catch (e: any) {
      console.log(`❌ Failed: ${e.message.split('\n')[0]}`);
    }
  }
}

main().catch(console.error);
