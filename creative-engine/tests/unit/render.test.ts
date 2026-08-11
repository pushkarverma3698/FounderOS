import { describe, it, expect, afterAll } from "vitest";
import { posterQuietTemplate } from "../../src/templates/poster-quiet/index.js";
import { renderTemplate } from "../../src/compose/render.js";
import { closeSharedBrowser } from "../../src/compose/browser.js";

describe("Compositor & poster-quiet Template", () => {
  afterAll(async () => {
    await closeSharedBrowser();
  });

  it("renders 3 passes and extracts slot bounding boxes correctly", async () => {
    const tokens = {
      palette: { bg: "#0d130e", text: "#ffffff", muted: "#a0aab0" },
      type: {
        display: { family: "sans-serif", weight: 800, tracking: -0.028 },
        utility: { family: "monospace", weight: 400, tracking: 0 },
        scale: [16, 20, 24, 32, 48, 72],
      },
      accent: "#ff5c47",
    };

    const copy = {
      kicker: "SEMINAR",
      headline: "WHO IS REALLY IN CONTROL OF YOUR HEALTH?",
      subheadline: "Two hours on your body, your mind, and your habits.",
      dateVenue: "Sun 2 Aug · 10:30 AM",
      price: "₹1,000",
      cta: "REGISTER",
      url: "konfhub.com/health",
    };

    const result = await renderTemplate(posterQuietTemplate, { tokens, copy });

    expect(result.renders.full).toBeInstanceOf(Buffer);
    expect(result.renders.plate).toBeInstanceOf(Buffer);
    expect(result.renders.mask).toBeInstanceOf(Buffer);
    expect(result.renders.thumb).toBeInstanceOf(Buffer);

    expect(result.slotBoxes.headline).toBeDefined();
    expect(result.slotBoxes.headline.width).toBeGreaterThan(0);
    expect(result.slotBoxes.headline.height).toBeGreaterThan(0);
    expect(result.slotBoxes.cta).toBeDefined();
  }, 15000);
});
