import { describe, it, expect } from "vitest";
import { getHexLuminance, calculateContrastRatio } from "../../src/metrics/contrast.js";
import { diceCoefficient } from "../../src/metrics/ocrReadback.js";
import { verifySafeAreaBreaches } from "../../src/metrics/safeArea.js";

describe("Metrics Module", () => {
  it("calculates WCAG luminances and contrast ratios correctly", () => {
    const whiteLum = getHexLuminance("#ffffff");
    const blackLum = getHexLuminance("#000000");
    const contrast = calculateContrastRatio(whiteLum, blackLum);

    expect(whiteLum).toBeCloseTo(1.0, 2);
    expect(blackLum).toBeCloseTo(0.0, 2);
    expect(contrast).toBeCloseTo(21.0, 1);
  });

  it("calculates Dice coefficient similarity accurately", () => {
    const sim1 = diceCoefficient("WHO IS REALLY IN CONTROL", "WHO IS REALLY IN CONTROL");
    const sim2 = diceCoefficient("WHO IS REALLY IN CONTROL", "WHO IS IN CONTROL");
    const sim3 = diceCoefficient("WHO IS REALLY IN CONTROL", "SOMETHING COMPLETELY DIFFERENT");

    expect(sim1).toBe(1.0);
    expect(sim2).toBeGreaterThan(0.7);
    expect(sim3).toBeLessThan(0.3);
  });

  it("detects safe area breaches correctly", () => {
    const safeArea = { x: 40, y: 40, width: 1000, height: 1270 };

    const safeBoxes = {
      headline: { x: 50, y: 50, width: 900, height: 200 },
    };

    const breachingBoxes = {
      headline: { x: 10, y: 50, width: 900, height: 200 }, // x < 40
    };

    expect(verifySafeAreaBreaches(safeBoxes, safeArea)).toBe(false);
    expect(verifySafeAreaBreaches(breachingBoxes, safeArea)).toBe(true);
  });
});
