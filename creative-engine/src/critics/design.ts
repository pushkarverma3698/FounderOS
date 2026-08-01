import { Finding, Variant, ConversionSpec, BrandKit } from "../contracts/schemas.js";

export interface CriticResult {
  scores: {
    conversion: number;
    hierarchy: number;
    brand: number;
    craft: number;
  };
  findings: Finding[];
  noFindings: boolean;
}

export function evaluateAnchoredDesign(
  variant: Variant,
  spec?: ConversionSpec | null,
  brand?: BrandKit | null
): CriticResult {
  const findings: Finding[] = [];

  // Check 1: Contrast / Legibility
  const contrastVals = Object.values(variant.metrics.contrastPerSlot);
  const minContrast = contrastVals.length > 0 ? Math.min(...contrastVals) : 21.0;

  if (minContrast < 4.5) {
    findings.push({
      severity: "major",
      dimension: "legibility",
      observation: `Contrast ratio ${minContrast.toFixed(2)} is below WCAG 4.5 requirement`,
      knob: "tokens",
      suggestedChange: "Increase contrast of token text color or darken scrim",
    });
  }

  // Check 2: Thumbnail Readback
  if (variant.metrics.thumbHeadlineOcr < 0.8) {
    findings.push({
      severity: "blocker",
      dimension: "legibility",
      observation: `Thumbnail headline OCR similarity ${variant.metrics.thumbHeadlineOcr.toFixed(2)} is below 0.80`,
      knob: "layout",
      suggestedChange: "Increase headline font size or tracking",
    });
  }

  // Check 3: Hierarchy Ratio
  if (variant.metrics.hierarchyRatio < 3.0) {
    findings.push({
      severity: "minor",
      dimension: "hierarchy",
      observation: "Headline font size ratio to utility text is under 3.0x",
      knob: "layout",
      suggestedChange: "Increase headline font scale or decrease utility text size",
    });
  }

  const conversion = spec?.urgencyBasis === "real" ? 0.95 : 0.85;
  const hierarchy = variant.metrics.hierarchyRatio >= 3.0 ? 0.9 : 0.7;
  const brandScore = variant.metrics.unverifiedFactOnCanvas ? 0.4 : 0.9;
  const craft = variant.metrics.safeAreaBreach ? 0.6 : 0.95;

  return {
    scores: {
      conversion,
      hierarchy,
      brand: brandScore,
      craft,
    },
    findings,
    noFindings: findings.length === 0,
  };
}
