/**
 * FounderOS v3 kernel — UnifiedTool → KernelTool adapter.
 * ========================================================
 * The canonical bridge between the 15 existing UnifiedTools (ToolResult
 * envelope A: { success, data, error }) and the kernel's worker engine.
 * ONE conversion path for every tool — the old system had per-department
 * ad-hoc string formatting that bypassed the failure taxonomy.
 *
 * Ordering per CLAUDE rules #4/#5, identical to the proven wrappers:
 *   HITL gate (DB row → interrupt) → idempotency check → execute → audit row.
 * Rejection and dedupe both return BEFORE the side effect can run.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import type { ToolResult, UnifiedTool } from "../tools/index.js";
import { hitlGate, idemKey } from "../infra/hitl.js";
import { hasBeenAudited, writeAuditEntry } from "../db/queries.js";
import { TENANT } from "../core/config.js";
import { TOOL_FAILURE_MARKER, type KernelTool } from "./worker.js";

/** HITL configuration for a gated (external side-effect) tool. */
export interface GateSpec {
  action: string;
  title: (args: Record<string, unknown>) => string;
  summary?: (args: Record<string, unknown>) => string;
  preview?: (args: Record<string, unknown>) => string;
  /** Content-addressed idempotency parts — same parts = the action runs once, ever. */
  idemParts: (args: Record<string, unknown>) => string[];
}

export interface AdaptOptions {
  gate?: GateSpec;
}

/**
 * Deterministic string envelope the worker LLM (and receipts) consume.
 * Success → the data, verbatim. Failure → "❌ …" + the structured marker so
 * isFailureResult() classifies it without touching model prose.
 */
export function formatToolResult(name: string, res: ToolResult): string {
  if (res.success) {
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? { ok: true });
  }
  return `❌ ${name} failed: ${res.error ?? "unknown error"} ${TOOL_FAILURE_MARKER} stage=tool]]`;
}

export function adaptTool(tool: UnifiedTool, opts: AdaptOptions = {}): KernelTool {
  return {
    name: tool.name,
    description: tool.description,
    async invoke(args: Record<string, unknown>, config?: RunnableConfig): Promise<string> {
      const gate = opts.gate;
      let key: string | undefined;

      if (gate) {
        const rejection = await hitlGate(
          {
            action: gate.action,
            title: gate.title(args),
            summary: gate.summary?.(args) ?? gate.title(args),
            preview: gate.preview?.(args) ?? JSON.stringify(args, null, 2).slice(0, 800),
            args,
          },
          config,
        );
        if (rejection) return rejection; // "❌ Rejected by founder." — terminal, no side effect.

        key = idemKey(gate.action, ...gate.idemParts(args));
        if (await hasBeenAudited(key)) {
          return `Skipped — this exact ${gate.action} already executed (idempotency key ${key}).`;
        }
      }

      const res = await tool.execute(args).catch(
        (err): ToolResult => ({ success: false, error: err instanceof Error ? err.message : String(err) }),
      );

      if (gate && key && res.success) {
        await writeAuditEntry({
          tenant_id: TENANT,
          action: gate.action,
          idempotency_key: key,
          payload: args,
        });
      }
      return formatToolResult(tool.name, res);
    },
  };
}
