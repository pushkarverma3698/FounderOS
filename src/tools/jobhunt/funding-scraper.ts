/**
 * FounderOS — funding news scraper
 * ================================
 * Scrape startup funding news sites with plain `fetch` to discover company
 * names. These feed the registry grower, which probes their ATS boards.
 *
 * Zero cost: no API keys, no browser, no LLM. Just HTTP GET → regex extract.
 * Fail-open: a broken source is logged and skipped, never thrown.
 */

import { normaliseCompanyName } from "./sponsor-match.js";

export interface FundingSource {
  readonly name: string;
  readonly url: string;
  readonly market: "IN" | "NL";
  /** Regex to extract company names from the HTML. Group 1 = company name. */
  readonly titlePattern: RegExp;
  /** Regex to extract funding details from article titles. */
  readonly fundingPattern: RegExp;
}

export interface FundingSignal {
  readonly company: string;
  readonly source: string;
  readonly market: "IN" | "NL";
  readonly headline: string;
}

export const FUNDING_SOURCES: readonly FundingSource[] = [
  {
    name: "YourStory",
    url: "https://yourstory.com/category/funding",
    market: "IN",
    titlePattern: /<h3[^>]*>([\s\S]*?)<\/h3>|<a[^>]+title="([^"]*(?:raises?|secures?|bags?|closes?|lands?|nabs?|gets?|snags?|receives?)[^"]*)"/gi,
    fundingPattern: /^([A-Z][\w\s&.-]+?)\s+(?:raises?|secures?|bags?|closes?|lands?|nabs?|gets?|snags?|receives?)/i,
  },
  {
    name: "Inc42",
    url: "https://inc42.com/buzz/funding-alert/",
    market: "IN",
    titlePattern: /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi,
    fundingPattern: /^([A-Z][\w\s&.-]+?)\s+(?:raises?|secures?|bags?|closes?|lands?|nabs?|gets?|snags?|receives?)/i,
  },
  {
    name: "Silicon Canals",
    url: "https://siliconcanals.com/tag/funding/",
    market: "NL",
    titlePattern: /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi,
    fundingPattern: /^([A-Z][\w\s&.-]+?)\s+(?:raises?|secures?|bags?|closes?|lands?|nabs?|gets?|snags?|receives?)/i,
  },
  {
    name: "EU-Startups",
    url: "https://www.eu-startups.com/category/funding/",
    market: "NL",
    titlePattern: /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi,
    fundingPattern: /^([A-Z][\w\s&.-]+?)\s+(?:raises?|secures?|bags?|closes?|lands?|nabs?|gets?|snags?|receives?)/i,
  },
];

const USER_AGENT = "founderos-funding-scraper/1.0 (+registry grower)";
const SCRAPE_TIMEOUT_MS = 15_000;

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Scrape one source. Never throws. */
export async function scrapeFundingSource(source: FundingSource): Promise<FundingSignal[]> {
  try {
    const response = await fetch(source.url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`funding-scraper: ${source.name} returned HTTP ${response.status}`);
      return [];
    }
    const html = await response.text();
    
    // Drop script/style blocks before stripping tags
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ");

    const signals: FundingSignal[] = [];
    const seen = new Set<string>();

    for (const match of body.matchAll(source.titlePattern)) {
      const rawTitle = match[1] || match[2];
      if (!rawTitle) continue;
      
      const title = stripHtml(rawTitle);
      const fundingMatch = title.match(source.fundingPattern);
      
      if (fundingMatch && fundingMatch[1]) {
        const rawCompany = fundingMatch[1].trim();
        const norm = normaliseCompanyName(rawCompany);
        
        if (norm && !seen.has(norm)) {
          seen.add(norm);
          signals.push({
            company: rawCompany,
            source: source.name,
            market: source.market,
            headline: title,
          });
        }
      }
    }
    return signals;
  } catch (err) {
    console.warn(`funding-scraper: failed to scrape ${source.name} —`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** Scrape all sources, return deduplicated company names. */
export async function scrapeAllFundingSources(): Promise<FundingSignal[]> {
  const allSignals = await Promise.all(FUNDING_SOURCES.map(scrapeFundingSource));
  const flat = allSignals.flat();
  
  const deduplicated: FundingSignal[] = [];
  const seen = new Set<string>();
  
  for (const sig of flat) {
    const norm = normaliseCompanyName(sig.company);
    if (!seen.has(norm)) {
      seen.add(norm);
      deduplicated.push(sig);
    }
  }
  
  return deduplicated;
}
