import { toolRegistry } from "./registry.js";
import { toolResolver } from "../gateway/resolver.js";
import { internalAdapter } from "../gateway/adapters/internal.js";
import { RuntimeAdapter } from "../gateway/adapters/runtime.js";

// Import existing tools to adapt them
import { claudeCodeTool } from "../claude-code.js";

import { vpsRunTool } from "../vps-run.js";

export function initializeToolRegistry(): void {
  // 1. claude_code (Runtime/CLI)
  toolRegistry.register({
    id: "claude_code",
    name: "claude_code",
    description: claudeCodeTool.description,
    layer: "runtime",
    transport: "internal", // Currently executed internally via Node spawn, but conceptually runtime
    inputSchema: claudeCodeTool.input_schema as any,
    sideEffect: "write",
    approval: "required", // Handled by gateway if we move it, or we keep it internal
    executorRef: "claude_code_exec",
    enabled: true,
  });
  internalAdapter.registerExecutor("claude_code_exec", async (args) => {
    return await claudeCodeTool.execute(args);
  });

  // 2. vps_run (Infrastructure)
  toolRegistry.register({
    id: "vps_run",
    name: "vps_run",
    description: vpsRunTool?.description || "Run a command on the VPS via SSH",
    layer: "infrastructure",
    transport: "internal",
    inputSchema: vpsRunTool?.input_schema as any,
    sideEffect: "write",
    approval: "required",
    executorRef: "vps_run_exec",
    enabled: true,
  });
  if (vpsRunTool) {
    internalAdapter.registerExecutor("vps_run_exec", async (args) => {
      return await vpsRunTool.execute(args);
    });
  }

  // 3. browser (Runtime)
  toolRegistry.register({
    id: "browser",
    name: "browser",
    description: "Browser automation on the host",
    layer: "runtime",
    transport: "internal",
    inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
    sideEffect: "write",
    approval: "required",
    executorRef: "browser_exec",
    enabled: true,
  });
  internalAdapter.registerExecutor("browser_exec", async (args) => {
    // Dynamic import to avoid circular dependencies if any, but let's just import it
    const { browserAction } = await import("../personal.js");
    const r = await browserAction(args.action as any, args);
    if (!r.ok) return { success: false, error: r.error };
    return { success: true, data: r.stdout };
  });

  // 4. Legacy stubs for CapabilityResolver build/test-time validation
  const legacyStubs = [
    "search_jobs", "search_web", "ingest_jobs", "scrape_url", "deep_research",
    "search_memory", "search_knowledge", "send_email", "read_cv", "cv_gaps",
    "screen_job", "review_screened", "tailor_cv_for_row", "job_brief",
    "linkedin_post", "linkedin_analytics", "linkedin_get_my_posts",
    "linkedin_read_comments", "draft_linkedin_reply", "draft_connection_note",
    "search_turicks_brain", "record_event", "crawl_site", "scan_ai_visibility",
    "get_gap_scans", "schedule_social_post", "list_scheduled_posts",
    "generate_image", "list_brand_assets"
  ];
  for (const toolId of legacyStubs) {
    if (!toolRegistry.getTool(toolId)) {
      toolRegistry.register({
        id: toolId, name: toolId, description: `Stub for ${toolId}`, layer: "integration",
        transport: "internal", inputSchema: { type: "object", properties: {} },
        sideEffect: "read", approval: "none", enabled: true,
      });
    }
  }
}
