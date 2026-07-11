/**
 * FounderOS — kernel model fallback wrapper (gateway seam)
 * =========================================================
 * Wraps the kernel's structural model interface (invoke + optional bindTools)
 * so AGENT_FALLBACK_MODELS actually engages on retriable provider failures.
 *
 * WHY HERE and not LangChain's withFallbacks: RunnableWithFallbacks does not
 * expose bindTools (the v2 lesson recorded at src/agents/model.ts
 * getSupervisorModel "@deprecated" note). The kernel only needs
 * { invoke, bindTools? }, so a structural combinator preserves tool binding
 * by re-wrapping the BOUND models.
 *
 * Engagement rule = isModelFallbackError (5xx/429/408/transport/404 retired
 * model). Auth failures (401/403) fail LOUD and never burn the chain — the
 * fallback shares no key with the primary, so silence would hide a misconfig
 * (audit Run B).
 *
 * 2026-07-11 incident this closes: prod Gemini died (free-tier 429, then the
 * gemini-2.5-flash retirement 404) and every turn errored at the founder even
 * though two free OpenRouter fallbacks were configured — kernel-boot injected
 * the bare primary model, so the chain never ran.
 */

import type { KernelBindableModel, KernelChatModel, KernelTool } from "../kernel/index.js";
import { isModelFallbackError } from "../agents/model.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "model-fallback" });

/**
 * Wrap a primary model with an ordered fallback chain. Returns the primary
 * untouched when the chain is empty (identity — zero overhead for tests and
 * single-model configs).
 */
export function withModelFallbacks(
  primary: KernelBindableModel,
  fallbacks: KernelBindableModel[],
  label = "kernel",
): KernelBindableModel {
  if (fallbacks.length === 0) return primary;

  return {
    async invoke(messages) {
      try {
        return await primary.invoke(messages);
      } catch (err) {
        if (!isModelFallbackError(err)) throw err;
        log.warn(
          { label, err: err instanceof Error ? err.message : String(err) },
          "Primary model failed retriably — engaging fallback chain",
        );
        let lastErr: unknown = err;
        for (const [i, fb] of fallbacks.entries()) {
          try {
            const reply = await fb.invoke(messages);
            log.info({ label, fallbackIndex: i }, "Fallback model answered");
            return reply;
          } catch (fbErr) {
            if (!isModelFallbackError(fbErr)) throw fbErr;
            log.warn(
              { label, fallbackIndex: i, err: fbErr instanceof Error ? fbErr.message : String(fbErr) },
              "Fallback model also failed retriably — trying next",
            );
            lastErr = fbErr;
          }
        }
        throw lastErr;
      }
    },
    bindTools(tools: KernelTool[]): KernelChatModel {
      const bind = (m: KernelBindableModel): KernelBindableModel =>
        m.bindTools ? m.bindTools(tools) : m;
      return withModelFallbacks(bind(primary), fallbacks.map(bind), label);
    },
  };
}
