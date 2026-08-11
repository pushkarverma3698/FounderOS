import { Variant, Metrics } from "../contracts/schemas.js";

export function computeLegibilityScore(metrics: Metrics): number {
  const ocrScore = metrics.thumbHeadlineOcr;

  // Min contrast headroom across slots
  const contrastValues = Object.values(metrics.contrastPerSlot);
  const minContrast = contrastValues.length > 0 ? Math.min(...contrastValues) : 4.5;
  const contrastScore = Math.min(1.0, minContrast / 4.5);

  const coveragePenalty = metrics.textCoverage > 0.38 ? 0.2 : 0;
  const rawScore = 0.6 * ocrScore + 0.4 * contrastScore - coveragePenalty;

  return Math.max(0.0, Math.min(1.0, rawScore));
}

export function calculateVariantScore(
  variant: Variant,
  criticScores: { conversion: number; hierarchy: number; brand: number; craft: number }
): number {
  const legibility = computeLegibilityScore(variant.metrics);

  const score =
    0.3 * criticScores.conversion +
    0.25 * legibility +
    0.15 * criticScores.hierarchy +
    0.15 * criticScores.brand +
    0.15 * criticScores.craft;

  return Math.round(score * 1000) / 1000;
}

export function selectBestVariant(variants: Variant[]): Variant | null {
  if (variants.length === 0) return null;

  const eligible = variants.filter((v) => v.eligible);
  const candidatePool = eligible.length > 0 ? eligible : variants;

  let best: Variant | null = null;
  let maxScore = -1;

  for (const v of candidatePool) {
    if (v.score > maxScore) {
      maxScore = v.score;
      best = v;
    }
  }

  return best;
}
