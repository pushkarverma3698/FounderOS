/**
 * FounderOS — ATS Per-Platform Rate Limiter
 * =========================================
 * Replaces coarse unbounded request bursts with per-ATS Bottleneck limiters.
 * Bounds both instantaneous concurrency (maxConcurrent) and request rate
 * (minTime + token-bucket reservoir).
 */

import Bottleneck from "bottleneck";
import type { FreeAts } from "./free-boards.js";

export interface PlatformRateConfig {
  readonly maxConcurrent: number;
  readonly minTimeMs: number;
  readonly burst: number;
  readonly refillRatePerSec: number;
}

export const ATS_RATE_PROFILES: Readonly<Record<FreeAts, PlatformRateConfig>> = {
  greenhouse: { maxConcurrent: 4, minTimeMs: 125, burst: 12, refillRatePerSec: 8 },
  lever: { maxConcurrent: 3, minTimeMs: 166, burst: 10, refillRatePerSec: 6 },
  ashby: { maxConcurrent: 2, minTimeMs: 250, burst: 6, refillRatePerSec: 4 },
  smartrecruiters: { maxConcurrent: 3, minTimeMs: 166, burst: 8, refillRatePerSec: 6 },
  workable: { maxConcurrent: 2, minTimeMs: 250, burst: 6, refillRatePerSec: 4 },
  personio: { maxConcurrent: 2, minTimeMs: 250, burst: 6, refillRatePerSec: 4 },
  recruitee: { maxConcurrent: 1, minTimeMs: 666, burst: 3, refillRatePerSec: 1 },
  workday: { maxConcurrent: 4, minTimeMs: 250, burst: 6, refillRatePerSec: 4 },
  teamtailor: { maxConcurrent: 4, minTimeMs: 166, burst: 8, refillRatePerSec: 6 },
  bamboohr: { maxConcurrent: 2, minTimeMs: 333, burst: 4, refillRatePerSec: 3 },
};

export interface LimiterOptions {
  /** When true, disables minTime and reservoir for zero-delay unit tests. */
  readonly zeroDelay?: boolean;
}

export function createPlatformLimiter(
  ats: FreeAts,
  options: LimiterOptions = {},
): Bottleneck {
  const profile = ATS_RATE_PROFILES[ats];
  if (options.zeroDelay) {
    return new Bottleneck({
      maxConcurrent: profile.maxConcurrent,
      minTime: 0,
    });
  }

  return new Bottleneck({
    maxConcurrent: profile.maxConcurrent,
    minTime: profile.minTimeMs,
    reservoir: profile.burst,
    reservoirIncreaseAmount: profile.refillRatePerSec,
    reservoirIncreaseInterval: 1000,
    reservoirIncreaseMaximum: profile.burst,
  });
}

export function createPlatformLimiters(
  options: LimiterOptions = {},
): Record<FreeAts, Bottleneck> {
  const limiters = {} as Record<FreeAts, Bottleneck>;
  for (const ats of Object.keys(ATS_RATE_PROFILES) as FreeAts[]) {
    limiters[ats] = createPlatformLimiter(ats, options);
  }
  return limiters;
}

let _sharedLimiters: Record<FreeAts, Bottleneck> | undefined;

/**
 * Shared production limiters reused across sweeps.
 * Defaults to zeroDelay in unit tests so mock-fetch tests run instantaneously.
 */
export function getSharedLimiters(options?: LimiterOptions): Record<FreeAts, Bottleneck> {
  if (!_sharedLimiters) {
    const isTest = process.env["NODE_ENV"] === "test" || Boolean(process.env["VITEST"]);
    const zeroDelay = options?.zeroDelay ?? isTest;
    _sharedLimiters = createPlatformLimiters({ zeroDelay });
  }
  return _sharedLimiters;
}

/** Test seam: reset shared limiters. */
export function resetSharedLimiters(): void {
  _sharedLimiters = undefined;
}
