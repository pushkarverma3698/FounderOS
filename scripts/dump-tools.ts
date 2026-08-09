import { buildProductionKernel } from "../src/gateway/kernel-boot.js";
import { MemorySaver } from "@langchain/langgraph";
import { closeDatabaseConnections } from "../src/db/client.js";


async function main() {
  const kernel = buildProductionKernel(new MemorySaver());
  console.log("Kernel built");
  await closeDatabaseConnections();
}
main().catch(console.error);
