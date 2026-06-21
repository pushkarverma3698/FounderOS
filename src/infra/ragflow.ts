/**
 * FounderOS — RAGFlow REST Client
 * =================================
 * Thin HTTP client for the RAGFlow self-hosted knowledge-base API.
 * RAGFlow handles its own chunking, embedding, and retrieval — eliminating
 * the need for a local Ollama instance on the VPS.
 *
 * Activation: set RAG_BACKEND=ragflow in .env, together with
 *   RAGFLOW_BASE_URL=http://<host>:<port>  (e.g. http://localhost:9380)
 *   RAGFLOW_API_KEY=ragflow-<token>
 *   RAGFLOW_DATASET_ID=<uuid>             (create once via UI or API)
 *
 * When RAG_BACKEND is unset or "pgvector" the existing Ollama+pgvector path
 * is used, so this is a zero-risk opt-in.
 *
 * Docs: https://ragflow.io/docs/dev/http_api_reference
 */

import { childLogger } from "./logger.js";

const log = childLogger({ module: "infra:ragflow" });

export interface RagflowChunk {
  content: string;
  score: number;
  document_name?: string;
  dataset_name?: string;
}

export class RagflowClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly datasetId: string;

  constructor(baseUrl: string, apiKey: string, datasetId: string) {
    // Strip trailing slash for consistent URL building
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.datasetId = datasetId;
  }

  private headers() {
    return {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Semantic search across this client's RAGFlow dataset.
   * Returns [] on any error (fail-open; caller sees empty results not a crash).
   */
  async search(query: string, topK = 5): Promise<RagflowChunk[]> {
    const url = `${this.baseUrl}/api/v1/retrieval`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          question: query,
          dataset_ids: [this.datasetId],
          top_k: Math.min(Math.max(topK, 1), 10),
          similarity_threshold: 0.1,
          vector_similarity_weight: 0.3,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error({ status: res.status, body }, "RAGFlow search request failed");
        return [];
      }

      const data = (await res.json()) as {
        data?: {
          chunks?: Array<{
            content?: string;
            similarity?: number;
            document_name?: string;
            dataset_name?: string;
          }>;
        };
      };

      return (data.data?.chunks ?? []).map((c) => ({
        content: c.content ?? "",
        score: typeof c.similarity === "number" ? c.similarity : 0,
        document_name: c.document_name,
        dataset_name: c.dataset_name,
      }));
    } catch (err) {
      log.error({ err, query }, "RAGFlow search error (non-fatal)");
      return [];
    }
  }

  /**
   * Upload raw text content as a named document into the dataset.
   * Used by the brain:sync script when RAG_BACKEND=ragflow.
   */
  async uploadText(filename: string, content: string): Promise<{ ok: boolean; documentId?: string }> {
    const url = `${this.baseUrl}/api/v1/datasets/${this.datasetId}/documents`;
    try {
      const form = new FormData();
      const blob = new Blob([content], { type: "text/plain" });
      form.append("file", blob, filename);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error({ status: res.status, body, filename }, "RAGFlow upload failed");
        return { ok: false };
      }

      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const documentId = data.data?.[0]?.id;
      log.info({ filename, documentId }, "RAGFlow document uploaded");

      // Trigger parsing/chunking of the uploaded document
      if (documentId) {
        await this.parseDocument(documentId).catch((e) =>
          log.warn({ documentId, err: e }, "RAGFlow parse trigger failed (non-fatal)"),
        );
      }

      return { ok: true, documentId };
    } catch (err) {
      log.error({ err, filename }, "RAGFlow upload error");
      return { ok: false };
    }
  }

  private async parseDocument(documentId: string): Promise<void> {
    const url = `${this.baseUrl}/api/v1/datasets/${this.datasetId}/chunks`;
    await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ document_ids: [documentId] }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}

let _client: RagflowClient | null | undefined = undefined;

/**
 * Returns the singleton RagflowClient when RAG_BACKEND=ragflow and required
 * env vars are set, null otherwise.
 */
export function getRagflowClient(): RagflowClient | null {
  if (_client !== undefined) return _client;
  const backend = process.env["RAG_BACKEND"] ?? "pgvector";
  if (backend !== "ragflow") {
    _client = null;
    return null;
  }
  const baseUrl = process.env["RAGFLOW_BASE_URL"];
  const apiKey = process.env["RAGFLOW_API_KEY"];
  const datasetId = process.env["RAGFLOW_DATASET_ID"];
  if (!baseUrl || !apiKey || !datasetId) {
    log.warn(
      "RAG_BACKEND=ragflow but RAGFLOW_BASE_URL / RAGFLOW_API_KEY / RAGFLOW_DATASET_ID not all set — falling back to pgvector",
    );
    _client = null;
    return null;
  }
  _client = new RagflowClient(baseUrl, apiKey, datasetId);
  log.info({ baseUrl, datasetId }, "RAGFlow client initialised");
  return _client;
}
