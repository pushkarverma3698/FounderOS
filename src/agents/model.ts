/**
 * FounderOS — Model Factory
 * =========================
 * Small, provider-agnostic model selection for the office graph.
 *
 * The model layer must stay boring: return plain LangChain chat model instances
 * and let LangChain/LangGraph handle tool binding, retries, and fallback
 * middleware. Never synthesize model output here.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { ChatOpenAI } from "@langchain/openai";
import { modelFallbackMiddleware } from "langchain";

export const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000] as const;

export type ModelProvider = "google-vertexai" | "google-genai" | "openai" | "anthropic" | "openrouter" | "omnirouter";

export interface ParsedModelId {
  provider: ModelProvider;
  model: string;
  id: string;
}

// Safety-net default when AGENT_MODEL is unset. Use the documented production
// model (CLAUDE.md), a strong agentic tool-caller — NOT a small model. A weak
// default (the old openrouter:openai/gpt-4o-mini) meant any env that forgot to
// set AGENT_MODEL silently degraded to a model that chats instead of calling
// tools. Dev/CI always set AGENT_MODEL explicitly; this only bites on misconfig,
// where Gemini Flash is the far safer failure mode.
export const DEFAULT_AGENT_MODEL = "openrouter:google/gemini-flash-latest";

/** Retired OpenRouter / Google model ids → current stable ids. */
const DEPRECATED_MODEL_ALIASES: Record<string, string> = {
  "google/gemini-2.5-flash-preview-05-20": "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-preview-05-20:free": "google/gemini-2.5-flash:free",
  "gemini-2.5-flash-preview-05-20": "gemini-2.5-flash",
  "gemini-2.0-flash": "gemini-2.5-flash",
  // 2026-07-11: gemini-2.5-flash returns 404 "no longer available to new
  // users" on newly billing-enabled Google Cloud projects (verified live).
  // gemini-flash-latest is Google's rolling alias to the current model.
  "google/gemini-2.5-flash": "google/gemini-flash-latest",
  "gemini-2.5-flash": "gemini-flash-latest",
  // 2026-08-27: dropped the OpenRouter free-tier dead-slug entries that used
  // to live here (meta-llama/llama-3.3-70b-instruct:free,
  // qwen/qwen3-next-80b-a3b-instruct:free, etc.). They all pointed at
  // "openrouter/free" or "google/gemma-4-31b-it:free" — guesses at "whatever
  // free model is alive today" baked into a compile-time table. That's the
  // wrong mechanism: free-tier slugs rot on a ~2-3 week cycle (this table was
  // patched three times, 08-06/08-23/08-27, chasing it) and a stale guess is
  // no better than the dead id it replaces — worse, actually: it swaps a
  // debuggable 404 (the real slug) for a still-broken 404 under a fake name
  // ("openrouter/free" was never a real OpenRouter model id). Live liveness
  // can only be established by calling the API, which is what
  // scripts/probe-openrouter-free-models.ts does as a pre-deploy check.
  // Aliases below stay because they're real, vendor-documented renames with a
  // guaranteed-live successor, not guesses.
};

export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = parseModelId(trimmed);
    const normalizedModel = DEPRECATED_MODEL_ALIASES[parsed.model] ?? parsed.model;
    if (normalizedModel === parsed.model) return trimmed;
    return `${parsed.provider}:${normalizedModel}`;
  } catch {
    return trimmed;
  }
}

/**
 * Extract the HTTP status from a provider error. Structured properties first
 * (OpenAI/Anthropic/Gemini SDK errors carry .status; fetch errors nest a
 * response), then the SDK message convention of a leading "NNN " prefix.
 * Returns null for transport-level errors that never got a response.
 */
export function httpStatusOf(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  const candidates = [
    e["status"],
    e["statusCode"],
    (e["response"] as { status?: unknown } | undefined)?.status,
    (e["error"] as { status?: unknown } | undefined)?.status,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && c >= 100 && c <= 599) return c;
  }
  const msg = (e as { message?: unknown }).message;
  if (typeof msg === "string") {
    const m = /^(\d{3})\b/.exec(msg.trim());
    if (m) {
      const n = Number(m[1]);
      if (n >= 100 && n <= 599) return n;
    }
  }
  if (e["cause"] && e["cause"] !== err) return httpStatusOf(e["cause"]);
  return null;
}

const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Retriable-by-class: 5xx + 408/429 by REAL status, transport errors by code,
 * plus the provider message idioms that carry no status at all. Definitively
 * NOT retriable: 4xx auth/permission/not-found — those surface loudly instead
 * of burning the fallback chain (audit Run B: a 403 must not look like load).
 */
export function is503Error(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status !== null && status !== 500) {
    // 500 also matches message idioms below; other statuses classify cleanly here.
    return status === 429 || status === 408 || status >= 501;
  }
  const code = (err as { code?: unknown } | null)?.code ?? ((err as { cause?: { code?: unknown } } | null)?.cause?.code);
  if (typeof code === "string" && TRANSPORT_CODES.has(code)) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    // Word-boundary matches — plain .includes("500") would false-match "port 5001".
    /\b503\b/.test(msg) ||
    /\b500\b/.test(msg) ||
    /\b429\b/.test(msg) ||
    msg.includes("high demand") ||
    msg.includes("Service Unavailable") ||
    msg.includes("Internal Server Error") ||
    /rate.?limit/i.test(msg) ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("socket hang up") ||
    /fetch failed/i.test(msg) ||
    /network (error|timeout)/i.test(msg)
  );
}

/**
 * Should the MODEL fallback chain engage? Everything retriable, PLUS 404 —
 * a retired/renamed model id (the 2026-06-27 gemini-2.5-flash:free incident:
 * 404, not 503, and the old chain never caught it). Auth failures (401/403)
 * stay excluded: the fallback shares the key, so falling back just hides the
 * real misconfig.
 */
export function isModelFallbackError(err: unknown): boolean {
  if (is503Error(err)) return true;
  return httpStatusOf(err) === 404;
}

export function isQuotaExhaustedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    /credits?\s*(are\s*)?depleted/.test(msg) ||
    /exceeded your current quota/.test(msg) ||
    /quota.*exceeded/.test(msg) ||
    /insufficient\s*(credits|funds|quota|balance)/.test(msg) ||
    /payment\s*required/.test(msg) ||
    (/\bbilling\b/.test(msg) && /quota|credit|exceed|depleted|payment/.test(msg))
  );
}

export function resolveTemperature(): number {
  const raw = process.env["AGENT_TEMPERATURE"];
  if (raw === undefined) return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function inferLegacyProvider(model: string): ModelProvider {
  const lower = model.toLowerCase();
  // Bare "gemini*" ids (no provider prefix) default to Vertex AI — the
  // production-reliable path (see buildModel). google-genai: still works when
  // explicitly prefixed.
  if (lower.includes("gemini")) return "google-vertexai";
  if (lower.includes("claude")) return "anthropic";
  return "openai";
}

export function parseModelId(modelId: string): ParsedModelId {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error("AGENT_MODEL cannot be empty.");
  }

  const separator = trimmed.indexOf(":");
  if (separator === -1) {
    const provider = inferLegacyProvider(trimmed);
    return { provider, model: trimmed, id: `${provider}:${trimmed}` };
  }

  const provider = trimmed.slice(0, separator) as ModelProvider;
  const model = trimmed.slice(separator + 1);
  if (!model) {
    throw new Error(`Model id "${modelId}" is missing the model name after the provider prefix.`);
  }

  if (!["google-vertexai", "google-genai", "openai", "anthropic", "openrouter", "omnirouter"].includes(provider)) {
    throw new Error(
      `Unsupported AGENT_MODEL provider "${provider}". Use google-vertexai:, google-genai:, openai:, anthropic:, openrouter:, or omnirouter:.`,
    );
  }

  return { provider, model, id: `${provider}:${model}` };
}

export function getConfiguredModelId(): string {
  const raw = process.env["AGENT_MODEL"]?.trim() || DEFAULT_AGENT_MODEL;
  return normalizeModelId(raw);
}

export function getFallbackModelIds(): string[] {
  // normalizeModelId() applies here too — previously only getConfiguredModelId()
  // and getWorkerModelId() normalized, so AGENT_FALLBACK_MODELS (the one place
  // a retired slug actually lived in prod) got zero protection from the alias
  // table above.
  return (process.env["AGENT_FALLBACK_MODELS"] ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .map(normalizeModelId);
}

export function getModel(): BaseChatModel {
  const parsed = parseModelId(getConfiguredModelId());
  const model = buildModel(parsed, resolveTemperature());
  if (!model) throw new Error(`Primary model ${parsed.id} is not configured (missing API key).`);
  return model;
}

/** @deprecated Supervisor uses getModel() — withFallbacks breaks createSupervisor bindTools. */
export function getSupervisorModel(): BaseChatModel {
  return getModel();
}

/**
 * Worker (department/specialist) model — roadmap #10 model split.
 *
 * Routing reliability lives in the SUPERVISOR, which keeps the strong primary
 * model (getModel()). Workers do tool-calling inside one department where the
 * task is already chosen, so they can run on a cheaper model with no routing
 * risk. Set WORKER_AGENT_MODEL to a cheaper id (e.g.
 * "openrouter:google/gemini-2.5-flash-lite") to take the saving.
 *
 * Default = the primary model, so behaviour is byte-identical until the founder
 * opts in. Same prefix rules as AGENT_MODEL. If the worker id is misconfigured
 * (missing key), we fail SAFE back to the primary rather than crash a department.
 */
export function getWorkerModelId(): string {
  const raw = process.env["WORKER_AGENT_MODEL"]?.trim();
  return raw && raw.length > 0 ? normalizeModelId(raw) : getConfiguredModelId();
}

export function getWorkerModel(): BaseChatModel {
  const workerId = getWorkerModelId();
  if (workerId === getConfiguredModelId()) return getModel(); // no split configured
  const parsed = parseModelId(workerId);
  const model = buildModel(parsed, resolveTemperature(), { optional: true });
  if (model) return model;
  // Misconfigured worker model (e.g. missing key) — fail safe to the primary.
  return getModel();
}

export function getModelFallbackMiddleware() {
  const fallbacks = buildFallbackModels();
  if (fallbacks.length === 0) return [];
  return [modelFallbackMiddleware(...fallbacks)];
}

function buildModel(
  parsed: ParsedModelId,
  temperature: number,
  opts: { optional?: boolean } = {},
): BaseChatModel | null {
  const optional = opts.optional ?? false;

  if (parsed.provider === "google-vertexai") {
    // Vertex AI authenticates via a GCP service-account key, never an API key.
    // Fail loud here rather than let ChatVertexAI fall through to ambient ADC
    // discovery (gcloud login file / GCE metadata) — that path only "works" on
    // a machine that happens to have a personal gcloud session and silently
    // breaks on any host that doesn't (prod has neither gcloud nor an ADC file).
    const credsPath = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
    const project = process.env["GOOGLE_CLOUD_PROJECT"];
    if (!credsPath || !project) {
      if (optional) return null;
      const missing = [!credsPath && "GOOGLE_APPLICATION_CREDENTIALS", !project && "GOOGLE_CLOUD_PROJECT"]
        .filter(Boolean)
        .join(" and ");
      throw new Error(`${missing} required for google-vertexai: models (GCP service-account auth).`);
    }
    return new ChatVertexAI({
      model: parsed.model,
      temperature,
      maxRetries: 2,
      authOptions: { keyFilename: credsPath, projectId: project },
      location: process.env["GOOGLE_CLOUD_LOCATION"]?.trim() || "us-central1",
    });
  }

  if (parsed.provider === "google-genai") {
    const apiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    if (!apiKey) {
      if (optional) return null;
      throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is required for google-genai: models.");
    }
    return new ChatGoogleGenerativeAI({
      apiKey,
      model: parsed.model,
      temperature,
      maxRetries: 2,
    });
  }

  if (parsed.provider === "anthropic") {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      if (optional) return null;
      throw new Error("ANTHROPIC_API_KEY is required for anthropic: models.");
    }
    return new ChatAnthropic({
      model: parsed.model,
      temperature,
      maxRetries: 2,
      apiKey: process.env["ANTHROPIC_API_KEY"],
    });
  }

  if (parsed.provider === "openrouter") {
    const apiKey = process.env["OPENROUTER_API_KEY"];
    if (!apiKey && !optional) {
      throw new Error("OPENROUTER_API_KEY is required for openrouter: models. Set it in .env or use a different AGENT_MODEL provider.");
    }
    return new ChatOpenAI({
      model: parsed.model,
      temperature,
      maxRetries: 2,
      apiKey: apiKey || "missing-openrouter-key",
      configuration: { baseURL: "https://openrouter.ai/api/v1" },
    });
  }

  if (parsed.provider === "omnirouter") {
    // OmniRouter runs on the laptop. Hardcoding 127.0.0.1 here means the prod
    // VPS — where nothing listens on 20128 — resolves this to a connection
    // refused on every call, and the fallback chain cannot rescue it because a
    // dead local proxy is not a provider error class. The override exists so
    // the box that runs the bot can say where its router is, or say it has none.
    return new ChatOpenAI({
      model: parsed.model,
      temperature,
      maxRetries: 2,
      // A local proxy authenticates by being local; the SDK still demands a value.
      apiKey: process.env["OMNIROUTER_API_KEY"] || "omnirouter-local",
      configuration: { baseURL: process.env["OMNIROUTER_BASE_URL"] || "http://127.0.0.1:20128/v1" },
    });
  }

  if (!process.env["OPENAI_API_KEY"] && optional) return null;
  return new ChatOpenAI({
    model: parsed.model,
    temperature,
    maxRetries: 2,
    ...(process.env["OPENAI_API_KEY"] ? { apiKey: process.env["OPENAI_API_KEY"] } : {}),
  });
}

export function buildFallbackModels(): BaseChatModel[] {
  return getFallbackModelIds()
    .map((id) => buildModel(parseModelId(id), resolveTemperature(), { optional: true }))
    .filter((m): m is BaseChatModel => m !== null);
}
