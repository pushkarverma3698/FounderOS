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

/**
 * One `<item><title>` from an RSS feed, CDATA-wrapped or not.
 *
 * Some publishers serve their feed but block their category HTML at the edge —
 * EU-Startups answers `/feed/` with 200 and `/category/funding/` with 403 to
 * every user-agent tried, browser headers included. A feed is also a cleaner
 * source than a rendered page: one title per item, no nav or teaser markup.
 */
export const RSS_TITLE_PATTERN =
  /<item[\s>][\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi;

/** Headline shape every source shares: "<Company> raises/secures/bags …". */
const FUNDING_HEADLINE =
  /^([A-Z][\w\s&.-]+?)\s+(?:raises?|secures?|bags?|closes?|lands?|nabs?|gets?|snags?|receives?)/i;

export const FUNDING_SOURCES: readonly FundingSource[] = [
  {
    name: "YourStory",
    url: "https://yourstory.com/category/funding",
    market: "IN",
    titlePattern: /<h3[^>]*>([\s\S]*?)<\/h3>|<a[^>]+title="([^"]*(?:raises?|secures?|bags?|closes?|lands?|nabs?|gets?|snags?|receives?)[^"]*)"/gi,
    fundingPattern: /^([A-Z][\w\s&.-]+?)\s+(?:raises?|secures?|bags?|closes?|lands?|nabs?|gets?|snags?|receives?)/i,
  },
  {
    // `/buzz/funding-alert/` returned 404 for at least 2026-09-03 → 09-07 (the
    // section was retired); `/tag/funding/` is the live equivalent, verified
    // 2026-09-08: HTTP 200, 43 headings, 5 signals extracted.
    name: "Inc42",
    url: "https://inc42.com/tag/funding/",
    market: "IN",
    titlePattern: /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi,
    fundingPattern: FUNDING_HEADLINE,
  },
  {
    name: "Silicon Canals",
    url: "https://siliconcanals.com/tag/funding/",
    market: "NL",
    titlePattern: /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi,
    fundingPattern: /^([A-Z][\w\s&.-]+?)\s+(?:raises?|secures?|bags?|closes?|lands?|nabs?|gets?|snags?|receives?)/i,
  },
  {
    // `/category/funding/` returns 403 to every user-agent tried, including a
    // full Chrome header set — an edge block, not a bot-UA problem, so there is
    // nothing to negotiate. The site-wide feed answers 200 to the plain bot UA
    // (verified 2026-09-08: 10 items, 5 signals), so the feed it is: it costs
    // topic targeting and buys the source back.
    name: "EU-Startups",
    url: "https://www.eu-startups.com/feed/",
    market: "NL",
    titlePattern: RSS_TITLE_PATTERN,
    fundingPattern: FUNDING_HEADLINE,
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
