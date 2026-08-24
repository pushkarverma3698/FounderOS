import { renderCvToPdf } from "../src/tools/jobhunt/cv-renderer.js";

async function main() {
  const markdown = "# Test CV\n\n## SKILLS\n\n- Python\n- Node.js";
  try {
    const result = await renderCvToPdf(markdown);
    if (result.pdfBuffer.length > 0) {
      console.log("PDF generation successful. Buffer length:", result.pdfBuffer.length);
    } else {
      console.error("PDF generation failed: Buffer is empty.");
      process.exit(1);
    }
  } catch (err) {
    console.error("PDF generation threw an error:", err);
    process.exit(1);
  }
}

main();
