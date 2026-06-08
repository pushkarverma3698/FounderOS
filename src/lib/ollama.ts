/**
 * Ollama local model client.
 *
 * Token-saving integration per CLAUDE.md "Local Model Routing" rules:
 *   - JSON extraction / code gen → qwen2.5-coder:7b
 *   - General reasoning / fast   → qwen2.5:7b
 *   - Embeddings                 → nomic-embed-text
 *
 * Both functions degrade gracefully — any error returns null so callers
 * can fall back to Claude without disrupting the production path.
 *
 * Controlled by:
 *   DISABLE_LOCAL_MODELS=1  — skip all Ollama calls (CI / no-GPU envs)
 *   OLLAMA_URL              — override base URL (default: http://localhost:11434)
 */

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const TIMEOUT_MS = 8_000; // 8 s — fast models should never take longer

/**
 * Model alias map.
 * Keys are usage aliases; values are the Ollama model names to pull.
 */
export const OLLAMA_MODEL_MAP: Record<string, string> = {
  // Text / code generation
  code: "qwen2.5-coder:7b",
  json: "qwen2.5:7b",
  fast: "qwen2.5:7b",
  // Convenience aliases used internally
  classify: "qwen2.5:7b",
  summarize: "qwen2.5:7b",
  // Embeddings (used by ollamaEmbed)
  embed: "nomic-embed-text",
};

function baseUrl(): string {
  return (process.env["OLLAMA_URL"] ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
}

/**
 * Generate text with a local Ollama model.
 *
 * @param alias  Key in OLLAMA_MODEL_MAP (e.g. "code", "json", "classify")
 * @param prompt The full prompt string
 * @returns Generated text, or null on any failure (Ollama down, HTTP error, etc.)
 */
export async function ollamaGenerate(alias: string, prompt: string): Promise<string | null> {
  if (process.env["DISABLE_LOCAL_MODELS"] === "1") return null;

  const model = OLLAMA_MODEL_MAP[alias] ?? OLLAMA_MODEL_MAP["fast"]!;
  const url = `${baseUrl()}/api/generate`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { response?: string };
    return typeof data.response === "string" ? data.response : null;
  } catch {
    return null;
  }
}

/**
 * Generate an embedding vector with nomic-embed-text.
 *
 * @param text  Text to embed
 * @returns Float array, or null on any failure
 */
export async function ollamaEmbed(text: string): Promise<number[] | null> {
  if (process.env["DISABLE_LOCAL_MODELS"] === "1") return null;

  const model = OLLAMA_MODEL_MAP["embed"]!;
  const url = `${baseUrl()}/api/embeddings`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { embedding?: number[] };
    return Array.isArray(data.embedding) ? data.embedding : null;
  } catch {
    return null;
  }
}
