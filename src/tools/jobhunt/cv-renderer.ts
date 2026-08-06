/**
 * FounderOS — ATS-safe CV Renderer
 * =================================
 * Converts Markdown resume content into ATS-optimized HTML and PDF.
 *
 * ATS Formatting Principles:
 *  - Single-column layout (no sidebars or flexbox columns)
 *  - Standard typography (Arial / System sans-serif)
 *  - High contrast black text on white background
 *  - Clean semantic HTML structure (h1, h2, p, ul, li)
 *  - Selectable text layer (rendered via Playwright Headless Chromium)
 */

import { chromium } from "playwright";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "tool:cv_renderer" });

/**
 * Basic markdown to HTML converter tailored for resume structure.
 * Handles headings, bold/italic, bullet lists, and paragraphs.
 */
export function markdownToAtsHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const htmlLines: string[] = [];
  let inList = false;

  const closeListIfNeeded = () => {
    if (inList) {
      htmlLines.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.length === 0) {
      closeListIfNeeded();
      continue;
    }

    // Format inline markdown (bold, italic, links)
    const formattedLine = line
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>")
      .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');

    if (formattedLine.startsWith("# ")) {
      closeListIfNeeded();
      htmlLines.push(`<h1>${formattedLine.slice(2)}</h1>`);
    } else if (formattedLine.startsWith("## ")) {
      closeListIfNeeded();
      htmlLines.push(`<h2>${formattedLine.slice(3)}</h2>`);
    } else if (formattedLine.startsWith("### ")) {
      closeListIfNeeded();
      htmlLines.push(`<h3>${formattedLine.slice(4)}</h3>`);
    } else if (formattedLine.startsWith("- ") || formattedLine.startsWith("* ")) {
      if (!inList) {
        htmlLines.push("<ul>");
        inList = true;
      }
      htmlLines.push(`  <li>${formattedLine.slice(2)}</li>`);
    } else {
      closeListIfNeeded();
      htmlLines.push(`<p>${formattedLine}</p>`);
    }
  }
  closeListIfNeeded();

  const bodyContent = htmlLines.join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Resume</title>
  <style>
    @page {
      size: A4;
      margin: 15mm 15mm 15mm 15mm;
    }
    body {
      font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
      color: #111111;
      background: #ffffff;
      line-height: 1.4;
      font-size: 10.5pt;
      margin: 0;
      padding: 0;
    }
    h1 {
      font-size: 18pt;
      margin: 0 0 4px 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #000000;
    }
    h2 {
      font-size: 12pt;
      border-bottom: 1px solid #333333;
      padding-bottom: 2px;
      margin: 14px 0 6px 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #111111;
    }
    h3 {
      font-size: 11pt;
      margin: 8px 0 2px 0;
      font-weight: bold;
    }
    p {
      margin: 0 0 4px 0;
    }
    ul {
      margin: 0 0 6px 0;
      padding-left: 18px;
    }
    li {
      margin-bottom: 3px;
    }
    strong {
      color: #000000;
    }
    a {
      color: #111111;
      text-decoration: none;
    }
  </style>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

export interface RenderResult {
  readonly pdfBuffer: Buffer;
  readonly htmlString: string;
}

/**
 * Render Markdown CV to ATS-friendly PDF buffer using Playwright headless Chromium.
 */
export async function renderCvToPdf(markdown: string): Promise<RenderResult> {
  const htmlString = markdownToAtsHtml(markdown);

  log.info("Rendering CV to PDF via Playwright");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(htmlString, { waitUntil: "networkidle" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "15mm",
        bottom: "15mm",
        left: "15mm",
        right: "15mm",
      },
    });
    return { pdfBuffer, htmlString };
  } finally {
    await browser.close();
  }
}
