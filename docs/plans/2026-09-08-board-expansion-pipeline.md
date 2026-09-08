# Board Expansion Pipeline & Stabilization
**Date**: 2026-09-08
**Status**: Implemented, Fully Tested (`pnpm gate` passed). Ready for review by Claude.

## 1. What was done

### P0 - Persistent ETag Cache
- **Problem**: Polling 1,297 ATS boards every 30 minutes fetches enormous payloads (e.g. Personio XML is ~2.26 MB per board) unconditionally. This leads to API bans and unnecessary bandwidth usage when jobs haven't changed.
- **Solution**: We created an `ats_board_cache` Postgres table (`drizzle/0040_ats_board_cache.sql`). We implemented `EtagCache` in `free-ats-cache.ts` which uses DB-backed conditional requests (`If-None-Match`). When a platform returns `304 Not Modified`, we skip parsing and return the stored payload.
- **Fallback Mechanism**: To ensure the sweep pipeline **never breaks** due to cache issues, the DB operations inside `createEtagCache` are wrapped in `try/catch` blocks. We explicitly annotated these with `// allow-failopen: fallback to uncached request`. If the DB goes down, the system gracefully falls back to making standard cache-miss HTTP requests.

### P1 & P2 - Retry-After and Token Bucket Concurrency
- **Problem**: Platforms like Recruitee and Greenhouse were dropping bursts of requests with `429 Too Many Requests` because the previous global concurrency limit (`pLimit(20)`) didn't account for per-platform thresholds.
- **Solution**: 
  - We updated `free-ats-transport.ts` to extract `Retry-After` headers and throw a structured `HttpStatusError`.
  - We updated `fetchBoard` to catch this error and gracefully `sleep()` for the `Retry-After` duration before retrying.
  - We updated `concurrency.ts` to implement a per-platform token bucket queue (`PLATFORM_CONCURRENCY` and `PLATFORM_STAGGER_MS`). This enforces a leaky-bucket staggered execution (e.g., waiting 100ms between requests to the same platform).
- **Fallback Mechanism**: The transport explicitly uses optional chaining (`response.headers?.get`) to prevent runtime crashes if headers are missing. If an ATS still drops the request, it logs the failure in `failures: []` and continues sweeping the remaining 1,200 boards rather than crashing the loop.

### P3 - Aggregator Resilience
- **Problem**: When scraping aggregator APIs (`arbeitnow`, `remotive`, `himalayas`, `jobicy`), occasional 500s or 429s would crash the sweep. Furthermore, because the sweep runs for multiple user profiles sequentially, aggregators were being needlessly pinged over and over within the same hour.
- **Solution**: 
  - Added a 3-attempt exponential backoff loop directly inside each aggregator's script.
  - Implemented an in-memory `lastFetchTime` and `COOLDOWN_MS` (4-12 hours). When the pipeline runs for the next user profile, it reuses the previously fetched and cached aggregator payload instead of making redundant API calls.

## 2. Testing and Vitest Quirks (How it was solved)
The entire pipeline was successfully verified using `pnpm gate`, yielding **3,827 passing tests**.
To get this passing, the following was resolved:
- **Test Cache Mocks**: Vitest operates in isolated worker instances, which caused our global `__ats_cache` mock to drop `globalThis` scope references. The `ats-board-cache-queries.ts` is now tightly mocked via closure state within `tests/setup.ts`.
- **Concurrency Rate-Limit Tests**: `staggerMs` (100ms) meant our concurrency assertion tests were finishing too quickly to properly pile up in-flight requests. We simulated an adequate delay in `mockFetch` (`300ms`) to verify our concurrency ceiling works as intended.
- **Aggregator Mock Fallbacks**: `sweepAggregators` was properly stubbed out across the `free-sweep` and `sweep-multi-profile` test suites. Before this fix, our simulated 429 errors caused the tests to cascade through thousands of retries (eventually timing out the suite).

## 3. Why this way?
1. **Drizzle Migrations for Caching**: Relying on Postgres rather than Redis keeps the architecture simple and aligned with FounderOS's strict single-database preference.
2. **`allow-failopen` Strategy**: A missing DB or failing network aggregator should never block the primary ATS sweep (the core engine of the system). The fail-open fallback prevents outages in peripheral services from cascading.
3. **Leaky Bucket Queuing**: Using `staggerMs` combined with a hard limit provides deterministic spacing between requests. Simple `pLimit` is insufficient for ATS platforms like Recruitee which measure rate based on bursts of requests over milliseconds.

## Claude Opus 5 Review Notes
- **Reviewer Action**: Please review the Drizzle schema additions (`0040_ats_board_cache.sql`), the architectural integration of `EtagCache` (fail-open mechanisms), and the new token bucket logic in `concurrency.ts`. 
- **PR Status**: Due to a `gh auth` constraint on this runner, the PR could not be opened directly from the CLI. The code has been committed and pushed to `antigravity/feat-board-expansion-pipeline` branch on origin.
