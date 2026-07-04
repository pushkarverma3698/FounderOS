/**
 * FounderOS — Creative department (nested sub-supervisor)
 * =======================================================
 * The ONE department that earns nesting (roadmap target architecture): a
 * Creative Director sub-supervisor over three specialists, each with a tight
 * 2-tool kit:
 *
 *   creative (Creative Director — routes only)
 *     ├─ art_director   → [generate_image(draft), list_brand_assets]
 *     ├─ copywriter     → [search_turicks_brain, search_web]
 *     └─ brand_designer → [generate_image(final, budget-gated), list_brand_assets]
 *
 * Compiled as a sub-graph WITHOUT its own checkpointer — the parent office
 * supplies persistence so any nested interrupt is crash-safe (same contract as
 * engineering-domain.ts / revenue-domain.ts). Context isolation is pinned
 * ("last_message") so a specialist's internal tool chatter never leaks up to the
 * parent supervisor (CLAUDE rule #20).
 *
 * No HITL inside this loop — drafts are internal. The publish gate fires later,
 * in comms/marketing, when a finished asset is actually sent (roadmap #8).
 */

import { createSupervisor } from "@langchain/langgraph-supervisor";
import { createAgent } from "langchain";
import { getModel, getWorkerModel, getModelFallbackMiddleware } from "./model.js";
import { createAgentMiddleware } from "../infra/context-manager.js";
import { CREATIVE_SUBAGENT_TOOLS } from "./capabilities.js";
import { assertContextIsolation, CONTEXT_ISOLATION_OUTPUT_MODE } from "./context-isolation.js";
import {
  CREATIVE_PROMPT,
  ART_DIRECTOR_PROMPT,
  COPYWRITER_PROMPT,
  BRAND_DESIGNER_PROMPT,
} from "./system-prompts.js";

const subAgentBudget = { maxTokens: 4000 };

/**
 * Build the nested `creative` sub-supervisor (over art_director + copywriter +
 * brand_designer), compiled WITHOUT its own checkpointer — the parent office
 * supplies persistence. Routing uses the strong model; specialists use the
 * cheaper worker model (roadmap #10 model split).
 */
export function buildCreativeDomain() {
  const routerModel = getModel();       // routing decision — strong/reliable
  const workerModel = getWorkerModel(); // specialists — cheapest viable
  const agentMiddleware = (prompt: string) => [
    ...getModelFallbackMiddleware(),
    ...createAgentMiddleware(prompt, subAgentBudget),
  ];

  const artDirector = createAgent({
    model: workerModel,
    tools: CREATIVE_SUBAGENT_TOOLS["art_director"]!,
    name: "art_director",
    includeAgentName: "inline",
    middleware: agentMiddleware(ART_DIRECTOR_PROMPT),
  }).graph;

  const copywriter = createAgent({
    model: workerModel,
    tools: CREATIVE_SUBAGENT_TOOLS["copywriter"]!,
    name: "copywriter",
    includeAgentName: "inline",
    middleware: agentMiddleware(COPYWRITER_PROMPT),
  }).graph;

  const brandDesigner = createAgent({
    model: workerModel,
    tools: CREATIVE_SUBAGENT_TOOLS["brand_designer"]!,
    name: "brand_designer",
    includeAgentName: "inline",
    middleware: agentMiddleware(BRAND_DESIGNER_PROMPT),
  }).graph;

  return createSupervisor({
    agents: [artDirector, copywriter, brandDesigner],
    llm: routerModel,
    prompt: CREATIVE_PROMPT,
    outputMode: assertContextIsolation(CONTEXT_ISOLATION_OUTPUT_MODE),
    includeAgentName: "inline",
    supervisorName: "creative",
  }).compile({ name: "creative" });
}
