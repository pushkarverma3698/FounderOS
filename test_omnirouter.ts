import { getModel } from './src/agents/model.js';

async function main() {
  process.env.AGENT_MODEL = "omnirouter:oc/big-pickle";
  const model = getModel();
  console.log("Invoking OmniRouter model (oc/big-pickle)...");
  const response = await model.invoke("Hello, who are you? Please reply in one short sentence.");
  console.log("\nResponse:", response.content);
}

main().catch(console.error);
