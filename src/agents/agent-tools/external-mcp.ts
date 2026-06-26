/**
 * FounderOS — External MCP Tool Wrapper (ADR-041)
 * ================================================
 * Re-wraps a LangChain tool loaded from an external MCP server so it obeys the
 * same safety contract as every native FounderOS write tool:
 *   - READ tools  → invoke straight through, mapping thrown errors to a
 *                   stage-tagged failure envelope (rule #12).
 *   - WRITE tools → idempotency check → hitlGate() approval → side effect →
 *                   writeAuditEntry(). Pure work (idem key) runs BEFORE the gate
 *                   so it re-runs cleanly when interrupt() replays the tool.
 *
 * Tools are renamed to `mcp__<server>__<bareName>` so they can never collide
 * with a native tool name, while the manifest `write` allowlist keeps matching
 * on the human-friendly bare name.
 */

import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { toolFailure } from "../tool-result.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";
import { isWriteTool, bridgedToolName } from "../../mcp/bridge-classify.js";
import type { BridgeManifest } from "../../mcp/bridge-manifest.js";

const log = childLogger({ module: "agent-tools:external-mcp" });

/** Minimal shape we rely on from a loaded MCP tool (a DynamicStructuredTool). */
export interface LoadedMcpTool {
  name: string;
  description?: string;
  schema: unknown;
  invoke(args: Record<string, unknown>, config?: RunnableConfig): Promise<unknown>;
}

function asText(out: unknown): string {
  if (typeof out === "string") return out;
  try {
    return JSON.stringify(out);
  } catch {
    return String(out);
  }
}

/**
 * Deterministic JSON with recursively sorted object keys. The idempotency key
 * must not depend on the order the model happened to emit arg keys in — without
 * this, `{channel,text}` and `{text,channel}` hash differently and the dedup
 * silently misses, firing a second approval for an already-performed write (H1).
 * Array element order remains significant (semantically meaningful).
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

function preview(args: Record<string, unknown>): string {
  const s = asText(args);
  return s.length > 800 ? `${s.slice(0, 800)}…` : s;
}

/**
 * Wrap one loaded external MCP tool with the FounderOS read/write safety
 * contract. The returned tool keeps the loaded schema but a namespaced name.
 */
export function gateMcpTool(
  loaded: LoadedMcpTool,
  serverName: string,
  manifest: BridgeManifest,
) {
  const bareName = loaded.name;
  const runtimeName = bridgedToolName(serverName, bareName);
  const gated = isWriteTool(serverName, bareName, manifest);
  const baseDesc = loaded.description ?? `External ${serverName} tool ${bareName}.`;
  const description = gated
    ? `${baseDesc} (external ${serverName} — requires founder approval)`
    : `${baseDesc} (external ${serverName} — read-only)`;

  return tool(
    async (args: Record<string, unknown>, config?: RunnableConfig): Promise<string> => {
      const callArgs = args ?? {};

      // Read-through: no gate, just an error boundary.
      if (!gated) {
        try {
          return asText(await loaded.invoke(callArgs, config));
        } catch (err) {
          return toolFailure("external_api", `${runtimeName} failed: ${(err as Error).message}`);
        }
      }

      // ── Write path ──────────────────────────────────────────────────────────
      // Pure, replay-safe work BEFORE the gate (interrupt() re-runs from here).
      const key = idemKey("mcp", serverName, bareName, stableStringify(callArgs));
      if (await hasBeenAudited(key)) {
        return `Already performed: ${runtimeName} (skipped duplicate).`;
      }

      const rejected = await hitlGate(
        {
          action: runtimeName,
          title: `🔌 ${serverName} → ${bareName} — proceed?`,
          summary: `External MCP write on "${serverName}": ${bareName}`,
          preview: preview(callArgs),
          args: callArgs,
        },
        config,
      );
      if (rejected) return rejected;

      // SIDE EFFECT only after approval.
      let out: string;
      try {
        out = asText(await loaded.invoke(callArgs, config));
      } catch (err) {
        return toolFailure("external_api", `${runtimeName} failed: ${(err as Error).message}`);
      }

      const audit = await writeAuditEntry({
        action: runtimeName,
        idempotency_key: key,
        payload: { server: serverName, tool: bareName },
        tenant_id: TENANT,
      });
      if (!audit.written) {
        // A concurrent duplicate already recorded this exact action — keep the
        // founder-facing claim honest rather than reporting a second success.
        log.warn({ key, runtimeName }, "writeAuditEntry: conflict (duplicate won the race)");
        return `Already performed: ${runtimeName} (duplicate suppressed).`;
      }

      return `✅ ${runtimeName} done: ${out}`;
    },
    {
      name: runtimeName,
      description,
      // Reuse the external tool's validated schema verbatim.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schema: loaded.schema as any,
    },
  );
}
