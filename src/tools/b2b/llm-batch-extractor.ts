export interface AmbiguousItem {
  index: number;
  cleanCompanyName: string;
  title: string;
  link: string;
  snippet?: string;
}

export interface LlmExtractionResult {
  index: number;
  name: string;
  title: string;
  confidence: number;
  evidence: string[];
}

export async function extractAmbiguousBatch(items: AmbiguousItem[]): Promise<LlmExtractionResult[]> {
  console.log(`[LLM Mock] Skipping real LLM call for ${items.length} items because no valid API key is present.`);
  return [];
}
