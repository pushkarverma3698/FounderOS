import { getModel } from './src/agents/model.js';

const modelsToTest = [
  "omnirouter:antigravity/claude-sonnet-5",
  "omnirouter:antigravity/claude-opus-4-6-thinking",
  "omnirouter:antigravity/claude-sonnet-4-6",
  "omnirouter:antigravity/gemini-3.5-flash-low",
  "omnirouter:antigravity/gemini-3.5-flash-medium",
  "omnirouter:antigravity/gemini-3.5-flash-high",
  "omnirouter:antigravity/gemini-3-pro-preview",
  "omnirouter:antigravity/gemini-3.1-pro-high",
  "omnirouter:antigravity/gemini-3.1-pro-low",
  "omnirouter:antigravity/gemini-3.1-flash-lite",
  "omnirouter:antigravity/gemini-2.5-pro",
  "omnirouter:antigravity/gemini-2.5-flash",
  "omnirouter:antigravity/gemini-2.5-flash-lite",
  "omnirouter:antigravity/gemini-2.5-flash-thinking",
  "omnirouter:antigravity/gpt-oss-120b-medium"
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
