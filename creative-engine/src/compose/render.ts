import sharp from "sharp";
import { getSharedBrowser } from "./browser.js";
import { RenderProps, TemplateModule } from "../templates/types.js";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderResult {
  renders: {
    full: Buffer;
    plate: Buffer;
    mask: Buffer;
    thumb: Buffer;
  };
  html: string;
  slotBoxes: Record<string, BoundingBox>;
}

export async function renderTemplate(
  template: TemplateModule,
  props: Omit<RenderProps, "layer">,
  options: { width?: number; height?: number } = {}
): Promise<RenderResult> {
  const width = options.width || 1080;
  const height = options.height || 1350;

  const browser = await getSharedBrowser();
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });

  try {
    // Pass 1: Full Render
    const fullHtml = template.render({ ...props, layer: "full", width, height });
    await page.setContent(fullHtml, { waitUntil: "networkidle" });
    const fullBuffer = await page.screenshot({ type: "png", omitBackground: false });

    // Extract Bounding Boxes for data-slot elements
    const slotElements = await page.locator("[data-slot]").all();
    const slotBoxes: Record<string, BoundingBox> = {};

    for (const el of slotElements) {
      const slotId = await el.getAttribute("data-slot");
      if (slotId) {
        const box = await el.boundingBox();
        if (box) {
          slotBoxes[slotId] = {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          };
        }
      }
    }

    // Pass 2: Plate Only (Type Hidden)
    const plateHtml = template.render({ ...props, layer: "plate", width, height });
    await page.setContent(plateHtml, { waitUntil: "networkidle" });
    const plateBuffer = await page.screenshot({ type: "png", omitBackground: false });

    // Pass 3: Mask Only (Solid White on Black)
    const maskHtml = template.render({ ...props, layer: "mask", width, height });
    await page.setContent(maskHtml, { waitUntil: "networkidle" });
    const maskBuffer = await page.screenshot({ type: "png", omitBackground: false });

    // Generate Thumbnail (150px wide Lanczos)
    const thumbBuffer = await sharp(fullBuffer)
      .resize(150, undefined, { kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer();

    return {
      renders: {
        full: fullBuffer,
        plate: plateBuffer,
        mask: maskBuffer,
        thumb: thumbBuffer,
      },
      html: fullHtml,
      slotBoxes,
    };
  } finally {
    await page.close();
  }
}
