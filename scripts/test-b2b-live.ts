import { runDiscoveryBatch } from "../src/tools/b2b/discovery-controller";



async function main() {
  if (!process.env.SERPER_API_KEY) {
    console.error("Missing SERPER_API_KEY");
    process.exit(1);
  }
  
  console.log("Running discovery for a few lesser-known IND companies...");
  const companies = [
    "Machinefabriek en Staalbouw Nederland",
    "Advanced Automated Equipment",
    "@EasePay",
    "073 Meeting Company",
    "100 Grams"
  ];
  const results = await runDiscoveryBatch(companies);
  
  console.log("Results:");
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
