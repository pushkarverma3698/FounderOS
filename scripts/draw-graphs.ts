// Draw all FounderOS graphs using LangGraph's built-in getGraph().drawMermaid()

async function main() {
  const [
    { salesSubgraph },
    { engineeringSubgraph },
    { marketingSubgraph },
    { prospectingSubgraph },
  ] = await Promise.all([
    import("../src/agents/pods/sales.js"),
    import("../src/agents/pods/engineering.js"),
    import("../src/agents/pods/marketing.js"),
    import("../src/agents/pods/prospecting.js"),
  ]);

  console.log("\n========== SALES POD ==========");
  console.log(salesSubgraph.getGraph().drawMermaid());

  console.log("\n========== ENGINEERING POD ==========");
  console.log(engineeringSubgraph.getGraph().drawMermaid());

  console.log("\n========== MARKETING POD ==========");
  console.log(marketingSubgraph.getGraph().drawMermaid());

  console.log("\n========== PROSPECTING POD ==========");
  console.log(prospectingSubgraph.getGraph().drawMermaid());
}

main().catch(console.error);
