import { TemplateManifest } from "../types.js";

export const manifest: TemplateManifest = {
  id: "poster-quiet",
  aspects: ["4:5", "1:1", "9:16"],
  slots: {
    kicker: { role: "utility", maxChars: 40, required: false },
    headline: { role: "display", maxChars: 60, required: true },
    subheadline: { role: "sub", maxChars: 120, required: false },
    dateVenue: { role: "utility", maxChars: 80, required: true },
    price: { role: "utility", maxChars: 30, required: false },
    cta: { role: "cta", maxChars: 30, required: true },
    url: { role: "utility", maxChars: 50, required: false },
  },
  reserved: [
    { region: "top", extent: 0.45, reason: "Headline and kicker layout zone" },
    { region: "bottom", extent: 0.35, reason: "Detail rail and CTA button zone" },
  ],
  safeAreas: {
    "4:5": { x: 40, y: 40, width: 1000, height: 1270 },
    "1:1": { x: 40, y: 40, width: 1000, height: 1000 },
    "9:16": { x: 40, y: 120, width: 1000, height: 1680 },
  },
  requiredTokens: ["bg", "text", "accent", "muted"],
};
