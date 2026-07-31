import { StateGraph, START, END } from "@langchain/langgraph";
import { CreativeStateAnnotation } from "./state.js";
import {
  intakeNode,
  brandResolveNode,
  strategyNode,
  ideateNode,
  artDirectNode,
  plateGenNode,
  plateQaNode,
  composeNode,
  critiqueNode,
  selectNode,
  packageNode,
} from "./nodes.js";
import { routeNextNode } from "./routing.js";

export function buildCreativeGraph() {
  const workflow = new StateGraph(CreativeStateAnnotation)
    .addNode("intake", intakeNode)
    .addNode("brand_resolve", brandResolveNode)
    .addNode("strategy_spec", strategyNode)
    .addNode("ideate", ideateNode)
    .addNode("art_direct", artDirectNode)
    .addNode("plate_gen", plateGenNode)
    .addNode("plate_qa", plateQaNode)
    .addNode("compose", composeNode)
    .addNode("critique", critiqueNode)
    .addNode("select", selectNode)
    .addNode("package", packageNode)

    .addEdge(START, "intake")
    .addEdge("intake", "brand_resolve")
    .addEdge("brand_resolve", "strategy_spec")
    .addEdge("strategy_spec", "ideate")
    .addEdge("ideate", "art_direct")
    .addEdge("art_direct", "plate_gen")
    .addEdge("plate_gen", "plate_qa")
    .addEdge("plate_qa", "compose")
    .addEdge("compose", "critique")

    .addConditionalEdges("critique", routeNextNode, {
      compose: "compose",
      plate_gen: "plate_gen",
      select: "select",
    })

    .addEdge("select", "package")
    .addEdge("package", END);

  return workflow.compile();
}
