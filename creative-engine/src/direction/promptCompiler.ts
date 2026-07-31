import { ArtDirection, BrandKit } from "../contracts/schemas.js";

export const FIXED_NEGATIVE_BASE = [
  "no text",
  "no words",
  "no letters",
  "no numerals",
  "no logos",
  "no watermarks",
  "no signage",
  "no captions",
  "no neon",
  "no stock-photo smiles",
  "no plastic CGI skin",
  "no extra fingers",
];

export function compilePlatePrompt(
  direction: ArtDirection,
  brand?: BrandKit | null,
  visualThesis?: string
): { prompt: string; negatives: string[] } {
  // Load-bearing clause ordering per spec §8:
  // 1. Medium + Format
  // 2. Lighting (First!)
  // 3. Subject
  // 4. Palette
  // 5. Negative Space
  // 6. Lens + Grade

  const medium = "Fine-art editorial photograph, 4:5 vertical aspect ratio.";
  const lighting =
    "Soft directional natural light raking from upper left, subtle fill, moody dark background.";
  const subject = visualThesis || "Abstract organic hands resting peacefully, thoughtful health empowerment theme.";

  const paletteColors = Object.values(direction.tokens.palette || {}).join(", ");
  const paletteClause = paletteColors
    ? `Harmonious dark color palette with tones of ${paletteColors}.`
    : "Dark cinematic color grade.";

  const reservedClauses = direction.reserved
    .map((r) => `Empty clean uncluttered space in ${r.region} region for text placement`)
    .join(". ");
  const negativeSpaceClause = reservedClauses
    ? `Declaring explicit negative space: ${reservedClauses}.`
    : "Large smooth negative space at top and bottom.";

  const lensGrade =
    "85mm prime lens, shallow depth of field, subtle film grain, rich contrast, 8k high resolution.";

  const prompt = [
    medium,
    lighting,
    subject,
    paletteClause,
    negativeSpaceClause,
    lensGrade,
  ].join(" ");

  const brandAntiPatterns = (brand?.antiPatterns as string[]) || [];
  const negatives = [...FIXED_NEGATIVE_BASE, ...brandAntiPatterns, ...direction.plateNegatives];

  return { prompt, negatives };
}
