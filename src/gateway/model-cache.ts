/**
 * FounderOS — LLM response cache wrapper (gateway seam)
 * ======================================================
 * Wraps a kernel model so identical, SIDE-EFFECT-FREE LLM calls (planner +
 * synthesizer) can be served from the tenant-isolated Redis cache instead of
 * re-billing the provider. Layered OUTSIDE withModelFallbacks so a hit skips
 * the whole fallback chain.
 *
 * Safety rules baked into the design (these are why the wrapper is safe to ship
 * despite the kernel's determinism contract):
 *  1. OPT-IN: identity passthrough unless LLM_CACHE_ENABLED=true, so the default
 *     and CI builds are byte-identical and the golden set stays deterministic.
 *  2. TOOL CALLS ARE NEVER CACHED: bindTools() returns a non-caching wrapper.
 *     Only unbound (planner/synthesizer) calls cache — worker tool-calling that
 *     drives external side effects always recomputes.
 *  3. FULL INPUT IN THE KEY: hash covers model id + temperature + every message
 *     (role + content), so a prompt/model/temp change can never serve a stale
 *     response. Tenant id namespaces the key (KEYS.llmCache) — no cross-tenant
 *     sharing.
 *  4. FAIL-OPEN: a cache read/write error degrades to a live invoke, never an
 *     error at the founder. No-op entirely when REDIS_URL is unset.
 */

import { AIMessage, type BaseMessage, type MessageContent } from "@langchain/core/messages";
import type { KernelBindableModel, KernelChatModel, KernelTool } from "../kernel/index.js";
import { KEYS, hashPrompt, cacheGet, cacheSet } from "../infra/redis.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "model-cache" });

/** Cached payload — only `content` is stored, since planner/synthesizer read
 *  model output solely through `messageContentText(response.content)`. */
interface CachedResponse {
  content: MessageContent;
}

/** Storage port — injectable so unit tests need no Redis. Defaults to the
 *  fail-open Redis helpers. */
export interface LlmCachePort {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void>;
}

const defaultPort: LlmCachePort = {
  get: (key) => cacheGet<CachedResponse>(key),
  set: (key, value, ttl) => cacheSet(key, value, ttl),
};

export interface LlmCacheOptions {
  enabled: boolean;
  tenantId: string;
  /** Resolved model id — part of the hash so different models never collide. */
  modelId: string;
  /** Sampling temperature — part of the hash for the same reason. */
  temperature: number;
  ttlSeconds: number;
  /** Override for tests; defaults to the Redis-backed port. */
  port?: LlmCachePort;
}

/** Deterministic, provider-agnostic view of the prompt for hashing. */
function promptKey(opts: LlmCacheOptions, messages: BaseMessage[]): string {
  const payload = {
    model: opts.modelId,
    temperature: opts.temperature,
    messages: messages.map((m) => ({ role: m.getType(), content: m.content })),
  };
  return KEYS.llmCache(opts.tenantId, hashPrompt(payload));
}

/**
 * Wrap a model with the LLM response cache. Returns the model untouched when
 * disabled (identity — zero overhead for tests, CI, and opted-out prod).
 */
export function withLlmCache(
  inner: KernelBindableModel,
  opts: LlmCacheOptions,
): KernelBindableModel {
  if (!opts.enabled) return inner;
  const port = opts.port ?? defaultPort;

  return {
    async invoke(messages: BaseMessage[]): Promise<AIMessage> {
      const key = promptKey(opts, messages);
      try {
        const hit = await port.get(key);
        if (hit) {
          log.debug({ tenant: opts.tenantId }, "LLM cache hit");
          return new AIMessage({ content: hit.content });
        }
      } catch (err) {
        // allow-failopen: cache read is an accelerant; a lookup error must never
        // block the real call.
        log.warn({ err: (err as Error).message }, "LLM cache read failed — invoking live");
      }

      const response = await inner.invoke(messages);
      try {
        await port.set(key, { content: response.content }, opts.ttlSeconds);
      } catch (err) {
        // allow-failopen: cache write is best-effort; the live response is
        // already computed and returned regardless.
        log.warn({ err: (err as Error).message }, "LLM cache write failed — skipping");
      }
      return response;
    },
    // Tool-calling is never cached — a bound model drives side effects, so it
    // must recompute every turn. Return the inner bound model directly.
    bindTools(tools: KernelTool[]): KernelChatModel {
      return inner.bindTools ? inner.bindTools(tools) : inner;
    },
  };
}
