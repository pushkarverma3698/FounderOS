import { chromium, Browser } from "playwright";

let cachedBrowser: Browser | null = null;

export async function getSharedBrowser(): Promise<Browser> {
  if (!cachedBrowser || !cachedBrowser.isConnected()) {
    cachedBrowser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return cachedBrowser;
}

export async function closeSharedBrowser(): Promise<void> {
  if (cachedBrowser) {
    await cachedBrowser.close();
    cachedBrowser = null;
  }
}
