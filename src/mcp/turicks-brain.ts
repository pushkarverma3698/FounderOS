#!/usr/bin/env node
/**
 * Brain-only MCP entry (ADR-038) — kept so configs that still start this file
 * keep working. It is the FounderOS hub (hub.ts) in "brain" scope: the same five
 * tools (search_memory, get_memory, remember, save_decision, save_bug) from
 * brain-tools.ts. New configs should start hub.ts.
 */

import { runHubStdio } from "./hub.js";

runHubStdio("brain").catch((err) => {
  console.error("Brain MCP failed to start:", err);
  process.exit(1);
});
