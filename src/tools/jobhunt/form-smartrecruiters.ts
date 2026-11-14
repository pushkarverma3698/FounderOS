/**
 * FounderOS — SmartRecruiters apply flow. The job page (jobs.smartrecruiters.com/<Company>/<id>) is only a posting.
 * Its "I'm interested" link (any language) goes to a separate apply app at /oneclick-ui/company/<Company>/publication/<uuid>,
 * which sits behind a DataDome bot check (geo.captcha-delivery.com interstitial; reproduced 2026-11-14 on a live KPN role).
 * We follow the link, and when a bot check or an expired posting blocks the form we say so. No bypass is attempted.
 */
import type { Page } from "playwright";

const GENERIC_NO_FIELDS =
  "no fillable form fields were found on this page (the form may be behind a login or custom widget)";

const APPLY_HREF = /\/oneclick-ui\/company\/[^/]+\/publication\/[^/?#]+/i;
const EXPIRED_TEXT = /this job has expired|job is no longer (available|accepting)|no longer accepting applications|deze vacature is verlopen/i;
const BOT_CHECK_FRAME = 'iframe[src*="captcha-delivery.com"], iframe[src*="datadome" i]';

/** The apply-app link out of a posting page's hrefs, resolved against the page URL. Pure. */
export function pickSmartRecruitersApplyHref(hrefs: readonly string[], pageUrl: string): string | null {
  for (const href of hrefs) {
    if (!APPLY_HREF.test(href)) continue;
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      continue; // not a URL; try the next link
    }
  }
  return null;
}

/** From the posting page, open the separate apply app (the form is not on the posting itself). */
export async function revealSmartRecruitersForm(page: Page): Promise<void> {
  // allow-failopen: networkidle is best-effort; the link check below decides what happens.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  if (APPLY_HREF.test(new URL(page.url()).pathname)) return; // already inside the apply app
  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))
    // allow-failopen: no links means no apply app to open; the reason helper reports the page state.
    .catch(() => [] as string[]);
  const target = pickSmartRecruitersApplyHref(hrefs, page.url());
  if (!target) return;
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // allow-failopen: a bot check never settles; the reason helper reports it.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
}

/** Why a SmartRecruiters page yielded no fields, in words the founder can act on. */
export async function noFieldsReason(page: Page, platform: string): Promise<string> {
  if (platform !== "smartrecruiters") return GENERIC_NO_FIELDS;
  // allow-failopen: an unreadable page falls through to the generic SmartRecruiters reason.
  if ((await page.locator(BOT_CHECK_FRAME).count().catch(() => 0)) > 0) {
    return "SmartRecruiters: the apply page sits behind a DataDome bot check that automated browsers cannot pass; apply by hand from the job link";
  }
  // allow-failopen: unreadable text means the expiry check is skipped.
  const text = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  if (EXPIRED_TEXT.test(text)) return "SmartRecruiters: this job has expired and no longer takes applications";
  if (!APPLY_HREF.test(new URL(page.url()).pathname)) {
    return "SmartRecruiters: no apply link was found on the job page, so the form could not be opened";
  }
  return "SmartRecruiters: the apply page showed no form fields (it may need a login or a custom widget)";
}
