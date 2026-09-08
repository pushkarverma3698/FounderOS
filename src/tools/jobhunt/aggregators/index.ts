/**
 * FounderOS — aggregator source registry
 * ========================================
 * The list of all aggregator sources the sweep can poll. Adding a source is
 * one line here and one adapter file — no other file needs to change.
 */

import type { AggregatorSource } from "./types.js";
import { createArbeitnowSource } from "./arbeitnow.js";
import { createRemotiveSource } from "./remotive.js";
import { createHimalayasSource } from "./himalayas.js";
import { createJobicySource } from "./jobicy.js";

export type { AggregatorSource, AggregatorJob } from "./types.js";

/**
 * All aggregator sources. Order matters only for logging — each source runs
 * sequentially to stay within their individual rate limits.
 */
export function getAllAggregatorSources(): readonly AggregatorSource[] {
  return [
    createArbeitnowSource(),
    createRemotiveSource(),
    createHimalayasSource(),
    createJobicySource(),
  ];
}
