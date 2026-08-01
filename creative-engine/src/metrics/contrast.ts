import sharp from "sharp";
import { BoundingBox } from "../compose/render.js";

/** Convert hex color string to relative luminance (WCAG 2.1) */
export function getHexLuminance(hex: string): number {
  let cleanHex = hex.replace("#", "");
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split("").map((c) => c + c).join("");
  }
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;

  const sR = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  const sG = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  const sB = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

  return 0.2126 * sR + 0.7152 * sG + 0.0722 * sB;
}

/** Compute WCAG 2.1 contrast ratio between two relative luminances */
export function calculateContrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Compute median relative luminance of image region inside a bounding box */
export async function getRegionMedianLuminance(
  plateBuffer: Buffer,
  box: BoundingBox
): Promise<number> {
  const metadata = await sharp(plateBuffer).metadata();
  const imgWidth = metadata.width || 1080;
  const imgHeight = metadata.height || 1350;

  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const width = Math.min(imgWidth - left, Math.ceil(box.width));
  const height = Math.min(imgHeight - top, Math.ceil(box.height));

  if (width <= 0 || height <= 0) return 0.5;

  const { data, info } = await sharp(plateBuffer)
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const luminances: number[] = [];
  const channels = info.channels;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const sR = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
    const sG = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
    const sB = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
    luminances.push(0.2126 * sR + 0.7152 * sG + 0.0722 * sB);
  }

  luminances.sort((a, b) => a - b);
  const mid = Math.floor(luminances.length / 2);
  return luminances.length % 2 !== 0
    ? luminances[mid]
    : (luminances[mid - 1] + luminances[mid]) / 2;
}

export async function calculateContrastPerSlot(
  plateBuffer: Buffer,
  slotBoxes: Record<string, BoundingBox>,
  tokenColors: Record<string, string>
): Promise<Record<string, number>> {
  const contrastMap: Record<string, number> = {};

  for (const [slotId, box] of Object.entries(slotBoxes)) {
    const fgColor = tokenColors[slotId] || "#ffffff";
    const fgLum = getHexLuminance(fgColor);
    const bgLum = await getRegionMedianLuminance(plateBuffer, box);
    contrastMap[slotId] = calculateContrastRatio(fgLum, bgLum);
  }

  return contrastMap;
}
