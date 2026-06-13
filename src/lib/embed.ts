/**
 * Local embedding via Ollama (nomic-embed-text). Used for RAG query embedding.
 * RAG text never leaves the box — privacy requirement (no API egress).
 */
import { env } from "../core/config.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "lib:embed" });

interface OllamaEmbedResponse {
  embedding?: number[];
}

/** Embed a single string into a vector. Throws on failure (fail-loud). */
export async function embedText(text: string): Promise<number[]> {
  let resp: Response;
  try {
    resp = await fetch(`${env.OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.error({ err }, "Ollama embeddings unreachable");
    throw new Error(
      `Ollama embeddings unreachable at ${env.OLLAMA_URL}. Is the ollama container up and is '${env.EMBED_MODEL}' pulled?`,
    );
  }
  if (!resp.ok) {
    throw new Error(`Ollama embeddings returned HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as OllamaEmbedResponse;
  if (!data.embedding || data.embedding.length === 0) {
    throw new Error("Ollama embeddings response missing 'embedding' field");
  }
  return data.embedding;
}
