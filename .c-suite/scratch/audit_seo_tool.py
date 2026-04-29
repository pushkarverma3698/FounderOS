import asyncio
import sys
import os

# Ensure we can import from .c-suite
sys.path.insert(0, "/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite")

from core.config import call_firecrawl

async def test_seo_tool():
    print("🌐 Starting SEO Tool Audit (Firecrawl)...")
    url = "https://turicks.com"
    
    print(f"\nScraping {url}...")
    try:
        result = await call_firecrawl(url)
        
        if result and len(result) > 500:
            print(f"\n✅ PASSED: Successfully extracted {len(result)} characters.")
            print("\nPreview:")
            print(result[:300] + "...")
        else:
            print("\n❌ FAILED: Received empty or insufficient content.")
            
    except Exception as e:
        print(f"❌ Error during test: {e}")

if __name__ == "__main__":
    asyncio.run(test_seo_tool())
