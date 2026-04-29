"""
FounderOS — PDF Engine Fallback (v1.0)
======================================
A pure-Python PDF generator using fpdf2.
Used when WeasyPrint / libgobject dependencies are missing.
"""

import os
from fpdf import FPDF
import markdown
from bs4 import BeautifulSoup

class SimplePDFFallback(FPDF):
    def header(self):
        pass # Optional: add simple header tracking

    def footer(self):
        self.set_y(-15)
        self.set_font("helvetica", "I", 8)
        self.cell(0, 10, f"Page {self.page_no()}", align="C")

def generate_pdf_fallback(md_content: str, output_pdf_path: str):
    """
    Robust, dependency-light PDF generation for JobOS resumes/outreach.
    """
    pdf = SimplePDFFallback()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)
    
    # Simple parsing: Convert MD to HTML then to PDF blocks
    html = markdown.markdown(md_content)
    soup = BeautifulSoup(html, "html.parser")
    
    pdf.set_font("helvetica", "", 11)
    
    for element in soup.find_all(['h1', 'h2', 'h3', 'p', 'li']):
        if element.name == 'h1':
            pdf.set_font("helvetica", "B", 24)
            pdf.cell(0, 20, element.get_text(), ln=True)
            pdf.ln(5)
        elif element.name == 'h2':
            pdf.set_font("helvetica", "B", 14)
            pdf.cell(0, 10, element.get_text().upper(), ln=True)
            pdf.line(pdf.get_x(), pdf.get_y(), pdf.get_x() + 190, pdf.get_y())
            pdf.ln(5)
        elif element.name == 'h3':
            pdf.set_font("helvetica", "B", 12)
            pdf.cell(0, 10, element.get_text(), ln=True)
        elif element.name == 'p':
            pdf.set_font("helvetica", "", 11)
            pdf.multi_cell(0, 8, element.get_text())
            pdf.ln(2)
        elif element.name == 'li':
            pdf.set_font("helvetica", "", 11)
            pdf.cell(10, 8, "-", ln=0)
            pdf.multi_cell(0, 8, element.get_text())
            pdf.ln(1)

    pdf.output(output_pdf_path)
    return True

if __name__ == "__main__":
    generate_pdf_fallback("# Test Name\n## Experience\n- Added fallback logic", "/tmp/fallback_test.pdf")
