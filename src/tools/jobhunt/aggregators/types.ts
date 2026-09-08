/**
 * FounderOS — aggregator source types
 * ====================================
 * The contract for free job aggregator APIs (Arbeitnow, Remotive, Himalayas,
 * Jobicy). These differ from ATS board adapters: they return fully-formed job
 * listings, not raw board payloads, so they do not need the AtsAdapter interface.
 *
 * Aggregators serve two purposes:
 *   1. JOBS — postings the free lane has never seen, from companies it does not
 *      track. These feed the same screening pipeline as ATS sweep results.
 *   2. TOKENS — every aggregator posting carries a URL pointing at the original
 *      ATS board. `extractBoardToken` harvests those into the board registry,
 *      which compounds: one aggregator sweep discovers boards that every future
 *      ATS sweep polls directly, for free, forever.
 *
 * Everything here is a type. The adapters (arbeitnow.ts, remotive.ts, etc.)
 * implement the fetch, and aggregator-source.ts orchestrates the sweep.
 */

/** One job listing from any aggregator, normalised to a common shape. */
export interface AggregatorJob {
  readonly title: string;
  readonly company: string;
  readonly url: string;
  readonly location: string;
  readonly description: string;
  readonly postedAt: Date | null;
  readonly source: string;
  /** Tags or categories the aggregator assigns. Informational, never screened. */
  readonly tags: readonly string[];
}

/**
 * One aggregator source. Stateless: `fetchJobs` is the only method, and it
 * returns every job the API exposes (within pagination limits). The caller
 * decides freshness, dedup, and screening — same split as the ATS lane.
 */
export interface AggregatorSource {
  /** Human-readable name, used in logs and ledger entries. */
  readonly name: string;
  /** Fetch all available jobs. Never throws — returns an empty array on failure. */
  fetchJobs(): Promise<readonly AggregatorJob[]>;
}
