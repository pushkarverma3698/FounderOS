import asyncio
from pathlib import Path
from playwright.async_api import async_playwright
import mac_client.apply as apply_mod

async def main():
    print("Capturing screenshot of the overlay after submit with the new 8s timeout...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()

        fixture_url = "file://" + str(Path("mac-client/tests/fixtures/greenhouse.html").resolve())
        await page.goto(fixture_url, wait_until="domcontentloaded")

        filled = ["first name", "email"]
        skipped = ["resume (no upload field found)"]

        # Inject overlay
        await page.evaluate(
            apply_mod.OVERLAY_JS.read_text(),
            {
                "position": "1 of 1",
                "company": "Debug Inc",
                "title": "Visual Tester",
                "filled": filled,
                "skipped": skipped,
            },
        )

        # Click the overlay submit button
        await page.evaluate("document.querySelectorAll('#founderos-bar button')[1].click()")
        
        # Wait 7 seconds (just before the 8s timeout navigates away)
        await asyncio.sleep(7)

        # Take screenshot
        await page.screenshot(path="debug-screenshot-after-submit.png", full_page=True)
        print("Saved to debug-screenshot-after-submit.png")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
