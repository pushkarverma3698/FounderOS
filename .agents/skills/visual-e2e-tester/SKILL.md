---
name: visual-e2e-tester
description: How to visually audit and debug End-to-End Browser UI flows using Playwright screenshots and image viewing.
---

# Visual E2E Tester Skill

This skill explains how the agent can act as a "senior QA tester" to visually verify that browser automations (like Playwright scripts) render UI elements correctly, and that injected overlays or CSS don't obscure content.

## When to use this skill
- When the user reports visual bugs like "the background was grey" or "the button was hidden".
- When the user asks you to "visually verify" or "see what happened" on the UI.
- When creating or modifying complex CSS injected into external websites where DOM assertions aren't enough to prove the UI looks right.

## Process: The Screenshot-and-View Workflow

To visually audit a web page, you must generate an image and then view it:

### Step 1: Instrument the Code to take a Screenshot
Use Playwright to save a screenshot of the browser state to a local path in the workspace.

If debugging an existing Python script (e.g., `mac_client.apply`), inject a temporary screenshot command right after the UI action you want to verify:
```python
await page.evaluate(OVERLAY_JS.read_text(), {...})
# Add this temporary debug line:
await page.screenshot(path="debug-screenshot.png", full_page=True)
```
If using Typescript (`playwrightBrowserAction`), you can inject JS that leverages HTML2Canvas or simply use the Playwright MCP server's built-in `browser_take_screenshot` tool.

### Step 2: Run the Instrumented Script
Execute the script so the automation runs and the image file is saved to disk.

### Step 3: View the Screenshot
Use your native `view_file` tool to inspect the generated image file. You have native multimodal vision capabilities, so when you call `view_file` on a `.png` or `.jpg`, you will literally see the image.
```json
{
  "AbsolutePath": "/Users/pushkarverma/Projects/founderos/debug-screenshot.png"
}
```

### Step 4: Analyze and Fix
Analyze the image. Look for:
- Overlays covering the entire screen.
- Unexpected background colors (e.g., solid grey).
- Z-index issues hiding the main content.

Use your visual findings to write a targeted CSS fix, apply the fix, and repeat Steps 1-3 to verify the issue is resolved.
