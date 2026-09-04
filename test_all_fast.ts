import { getModel } from './src/agents/model.js';

const modelsToTest = [
  "omnirouter:auto/gemini",
  "omnirouter:cw/claude-sonnet-5",
  "omnirouter:cc/claude-sonnet-5-high",
  "omnirouter:antigravity/gemini-3.5-flash-low",
  "omnirouter:antigravity/gemini-3.6-flash-high",
  "omnirouter:antigravity/gemini-pro-agent",
  "omnirouter:antigravity/gemini-3.1-pro-low",
  "omnirouter:tllm/gemini_3_pro",
  "omnirouter:tllm/gemini_2_5_pro"
];

const timeout = (ms: number) => new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${ms}ms)`)), ms));

async function main() {
  const working: string[] = [];
  const broken: string[] = [];
  
  for (const modelId of modelsToTest) {
    process.env.AGENT_MODEL = modelId;
    try {
      const model = getModel();
      const response = await Promise.race([
        model.invoke("Say 'yes'"),
        timeout(25000)
      ]) as any;
      working.push(modelId);
      console.log(`✅ ${modelId.padEnd(60)} : SUCCESS`);
    } catch (e: any) {
      broken.push(modelId);
      const msg = e.message.split('\n')[0].substring(0, 50);
      console.log(`❌ ${modelId.padEnd(60)} : ${msg}`);
    }
  }
  
  console.log("\n--- SUMMARY ---");
  console.log("WORKING MODELS:");
  working.forEach(m => console.log(m));
}

main().catch(console.error);
