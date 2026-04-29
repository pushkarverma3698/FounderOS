import sys
import os
import asyncio
import httpx

# Ensure we can import from .c-suite
sys.path.insert(0, "/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite")

from core.config import call_firecrawl

def test_scraper():
    print("🌐 Testing Firecrawl Scraper for turicks.com...")
    content = call_firecrawl("https://turicks.com")
    
    if "[Error]" in content:
        print(f"❌ Scraper Failed: {content}")
        return False
    
    print("✅ Scraper Success!")
    print(f"Content length: {len(content)} characters")
    print("\n--- Snippet ---")
    print(content[:500] + "...")
    return True

if __name__ == "__main__":
    test_scraper()
