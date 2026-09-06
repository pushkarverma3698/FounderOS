// src/tools/b2b/serper-client.ts
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { serperQueryCache } from "./schema";

const SERPER_URL = "https://google.serper.dev/search";

export interface SerperOrganicResult {
  title: string;
  link: string;
  snippet?: string;
}

export interface SerperResponse {
  organic?: SerperOrganicResult[];
}

// Retries transient failures only (timeouts, 5xx from Serper's own infra).
// This is not retrying past a block — if Serper's upstream Google access is
// having trouble, that's Serper's relationship with Google to manage, not
// something this client tries to route around.
async function fetchWithRetry(query: string, attempt = 0): Promise<SerperResponse> {
  console.log(`[Serper] Query: ${query}`);
  const res = await fetch(SERPER_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query }),
  });

  if (res.status >= 500 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    return fetchWithRetry(query, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Serper request failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

export async function serperSearch(query: string): Promise<SerperResponse> {
  let cached = [];
  try {
    cached = await db
      .select()
      .from(serperQueryCache)
      .where(eq(serperQueryCache.query, query))
      .limit(1);
  } catch (e) {
    console.warn("DB cache lookup failed, proceeding without cache.");
  }

  if (cached.length > 0) {
    return cached[0].rawResponse as SerperResponse;
  }

  const result = await fetchWithRetry(query);

  try {
    await db.insert(serperQueryCache).values({ query, rawResponse: result }).onConflictDoNothing();
  } catch (e) {
    console.warn("DB cache insert failed, ignoring.");
  }

  return result;
}
