"""
FounderOS — JobOS V3: PDF Generation Engine
============================================
Converts Markdown to a professional, single-column ATS-friendly PDF.
Uses WeasyPrint for high-fidelity rendering.
"""

import markdown
import os
import logging

log = logging.getLogger("PDFEngine")

# V7 Reliability: Graceful System Library Fallback
try:
    from weasyprint import HTML, CSS
    USE_WEASYPRINT = True
except (ImportError, OSError) as e:
    log.warning(f"[PDFEngine] WeasyPrint dependencies missing ({e}). Falling back to pure-Python engine.")
    USE_WEASYPRINT = False
    from utils.pdf_engine_fallback import generate_pdf_fallback

# Modern, single-column CSS for ATS compliance and premium look
RESUME_CSS = """
@page {
    size: A4;
    margin: 1in;
}

body {
    font-family: 'Inter', -apple-system, sans-serif;
    line-height: 1.5;
    color: #1a1a1a;
    font-size: 11pt;
}

h1 {
    font-size: 24pt;
    margin-bottom: 0px;
    color: #000;
}

h2 {
    font-size: 14pt;
    margin-top: 20px;
    border-bottom: 1px solid #ddd;
    padding-bottom: 5px;
    text-transform: uppercase;
    letter-spacing: 1px;
}

h3 {
    font-size: 12pt;
    margin-top: 15px;
    margin-bottom: 5px;
}

ul {
    padding-left: 20px;
}

li {
    margin-bottom: 5px;
}

p {
    margin: 5px 0;
}

.contact {
    font-size: 10pt;
    color: #666;
    margin-bottom: 20px;
}
"""

def generate_pdf(md_content: str, output_pdf_path: str):
    """
    Converts Markdown content to PDF with automatic fallback support.
    """
    if not USE_WEASYPRINT:
        return generate_pdf_fallback(md_content, output_pdf_path)

    try:
        log.info(f"📄 Rendering PDF (High-Fidelity) to: {output_pdf_path}")
        
        # 1. Convert Markdown to HTML
        html_body = markdown.markdown(md_content, extensions=['extra', 'smarty'])
        
        # 2. Add wrapper and CSS
        full_html = f"<html><head><style>{RESUME_CSS}</style></head><body>{html_body}</body></html>"
        
        # 3. Render to PDF
        HTML(string=full_html).write_pdf(output_pdf_path)
        
        log.info("✅ PDF Generation Successful.")
        return True
    except Exception as e:
        log.error(f"PDF generation failed: {e}")
        return False

if __name__ == "__main__":
    # Test
    test_md = "# Pushkar Verma\n## Experience\n- Built FounderOS\n- Optimized things by 40%"
    generate_pdf(test_md, "/tmp/test_resume.pdf")
