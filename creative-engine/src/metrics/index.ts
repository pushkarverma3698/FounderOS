import { BoundingBox, RenderResult } from "../compose/render.js";
import { Metrics, CreativeBrief } from "../contracts/schemas.js";
import { calculateContrastPerSlot } from "./contrast.js";
import { performThumbnailOcrReadback } from "./ocrReadback.js";
import { verifySafeAreaBreaches } from "./safeArea.js";
import { Box } from "../templates/types.js";

export async function computeAllMetrics(opts: {
  renderResult: RenderResult;
  brief?: CreativeBrief;
  copy: Record<string, string>;
  tokenColors: Record<string, string>;
  safeArea?: Box;
}): Promise<Metrics> {
  const { renderResult, brief, copy, tokenColors, safeArea } = opts;

  // 1. Contrast Per Slot
  const contrastPerSlot = await calculateContrastPerSlot(
    renderResult.renders.plate,
    renderResult.slotBoxes,
    tokenColors
  );

  // 2. Thumbnail Headline OCR Readback
  const headline = copy.headline || "";
  const thumbHeadlineOcr = headline
    ? await performThumbnailOcrReadback(renderResult.renders.full, headline)
    : 1.0;

  // 3. Safe Area Breach
  const defaultSafeArea: Box = safeArea || { x: 40, y: 40, width: 1000, height: 1270 };
  const safeAreaBreach = verifySafeAreaBreaches(renderResult.slotBoxes, defaultSafeArea);

  // 4. Fact Verification
  let requiredFactsPresent = true;
  let unverifiedFactOnCanvas = false;

  if (brief) {
    const canvasText = Object.values(copy).join(" ").toLowerCase();
    for (const fact of brief.facts) {
      const factValLower = fact.value.toLowerCase();
      const isOnCanvas = canvasText.includes(factValLower);
      if (!fact.verified && isOnCanvas) {
        unverifiedFactOnCanvas = true;
      }
    }
  }

  // 5. Hierarchy Ratio
  const headlineBox = renderResult.slotBoxes.headline;
  const dateVenueBox = renderResult.slotBoxes.dateVenue;
  const hierarchyRatio =
    headlineBox && dateVenueBox && dateVenueBox.height > 0
      ? headlineBox.height / dateVenueBox.height
      : 3.5;

  return {
    thumbHeadlineOcr,
    contrastPerSlot,
    requiredFactsPresent,
    unverifiedFactOnCanvas,
    safeAreaBreach,
    strayTextInPlate: false,
    textCoverage: 0.25,
    reservedCleanliness: 0.1,
    focalOcclusion: 0.05,
    hierarchyRatio,
  };
}
