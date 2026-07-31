import sharp from "sharp";
import { createWorker } from "tesseract.js";

/** Compute Dice coefficient over character bigrams */
export function diceCoefficient(str1: string, str2: string): number {
  const clean1 = str1.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const clean2 = str2.toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (clean1 === clean2) return 1.0;
  if (clean1.length < 2 || clean2.length < 2) return 0.0;

  const getBigrams = (str: string) => {
    const bigrams = new Map<string, number>();
    for (let i = 0; i < str.length - 1; i++) {
      const bigram = str.substring(i, i + 2);
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
    return bigrams;
  };

  const b1 = getBigrams(clean1);
  const b2 = getBigrams(clean2);

  let intersection = 0;
  for (const [bigram, count1] of b1.entries()) {
    const count2 = b2.get(bigram);
    if (count2) {
      intersection += Math.min(count1, count2);
    }
  }

  const total1 = clean1.length - 1;
  const total2 = clean2.length - 1;
  return (2.0 * intersection) / (total1 + total2);
}

export async function performThumbnailOcrReadback(
  fullImageBuffer: Buffer,
  expectedHeadline: string
): Promise<number> {
  // Step 1: Resize to 150px feed simulator
  // Step 2: Upscale x4 to 600px for OCR readability
  // Step 3: Greyscale & normalize contrast
  const processedBuffer = await sharp(fullImageBuffer)
    .resize(150, undefined, { kernel: sharp.kernel.lanczos3 })
    .resize(600, undefined, { kernel: sharp.kernel.lanczos3 })
    .greyscale()
    .normalize()
    .toBuffer();

  const worker = await createWorker("eng");
  try {
    const ret = await worker.recognize(processedBuffer, { psm: 11 });
    const recognizedText = ret.data.text || "";
    return diceCoefficient(expectedHeadline, recognizedText);
  } finally {
    await worker.terminate();
  }
}
