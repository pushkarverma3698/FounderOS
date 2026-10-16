/**
 * FounderOS — Combobox (React-Select / autocomplete) driver
 * =========================================================
 * Greenhouse and others render questions as `input[role=combobox]` with no `<select>`: the options exist only
 * in a listbox after ArrowDown (fixed lists) or after typing (async autocomplete). This module reads those
 * options at scrape time, picks the right one, and verifies the pick after blur by reading the shown value.
 */

import type { Locator, Page } from "playwright";

/** How long to wait for a fixed option list after ArrowDown while scraping. */
export const COMBOBOX_OPEN_WAIT_MS = 400;
/** How long to wait for the chosen option to appear when filling. */
export const COMBOBOX_CHOOSE_WAIT_MS = 2_000;
/** How long an async autocomplete gets to return a matching suggestion. */
export const COMBOBOX_TYPE_WAIT_MS = 4_000;
const POLL_MS = 100;

/** Minimal structural DOM types for browser `evaluate` callbacks (Node tsconfig omits `lib: ["dom"]`). */
interface DomElement {
  readonly id: string;
  readonly value?: string;
  readonly textContent: string | null;
  readonly parentElement: DomElement | null;
  getAttribute(name: string): string | null;
  closest(selector: string): DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

interface DomGlobal {
  readonly document: { getElementById(id: string): DomElement | null };
}

export function cssEscapeAttr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Use `[id="..."]` so dots/colons in Recruitee or React IDs never break CSS parsing. */
export function idSelector(id: string): string {
  return `[id="${cssEscapeAttr(id)}"]`;
}

const words = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * Pick the autocomplete suggestion for `value` ("Mohali, India"). The first comma segment must appear as a
 * whole word ("india" never matches "Indian"); among those, prefer the option naming the most other segments;
 * ties keep the provider's order. Returns null when no option names the place.
 */
export function pickAutocompleteOption(value: string, options: readonly string[]): string | null {
  const [first, ...rest] = value.split(",").map((s) => words(s)).filter((s) => s.trim().length > 0);
  if (!first) return null;
  let best: string | null = null;
  let bestScore = -1;
  for (const option of options) {
    const w = words(option);
    if (!w.includes(first)) continue;
    const score = rest.filter((seg) => w.includes(seg)).length;
    if (score > bestScore) {
      best = option;
      bestScore = score;
    }
  }
  return best;
}

interface Menu {
  readonly texts: readonly string[];
  item(index: number): Locator;
}

/** Read the open menu: the listbox named by `aria-controls`, else `[id*="-option-"]` inside the select container. */
async function readMenu(page: Page, input: Locator): Promise<Menu> {
  const snap = await input
    .evaluate((el) => {
      const dom = globalThis as unknown as DomGlobal;
      const inp = el as unknown as DomElement;
      const listId = inp.getAttribute("aria-controls");
      const list = listId ? dom.document.getElementById(listId) : null;
      const scope = list ?? inp.closest('[class*="control" i]')?.parentElement ?? null;
      const nodes = scope ? Array.from(scope.querySelectorAll(list ? '[role="option"]' : '[id*="-option-"]')) : [];
      return { listId, ids: nodes.map((n) => n.id), texts: nodes.map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim()) };
    })
    // allow-failopen: a detached or unreadable input reads as an empty menu; callers then report unverified.
    .catch(() => ({ listId: null, ids: [] as string[], texts: [] as string[] }));
  return {
    texts: snap.texts,
    item: (i) =>
      snap.ids[i] ? page.locator(idSelector(snap.ids[i]!)) : page.locator(`${idSelector(snap.listId ?? "")} [role="option"]`).nth(i),
  };
}

/** Poll the menu until `pick` returns an index or the wait runs out. */
async function pollMenu(
  page: Page,
  input: Locator,
  waitMs: number,
  pick: (texts: readonly string[]) => number,
): Promise<{ readonly menu: Menu; readonly index: number; readonly sawOptions: boolean }> {
  const deadline = Date.now() + waitMs;
  let sawOptions = false;
  for (;;) {
    const menu = await readMenu(page, input);
    sawOptions ||= menu.texts.length > 0;
    const index = pick(menu.texts);
    if (index >= 0 || Date.now() >= deadline) return { menu, index, sawOptions };
    await page.waitForTimeout(POLL_MS);
  }
}

/** True when the combobox now shows exactly `expected`: its single-value text, or its own value. */
async function comboboxShows(input: Locator, expected: string): Promise<boolean> {
  return input
    .evaluate((el, want) => {
      const inp = el as unknown as DomElement;
      const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      if (norm(inp.value) === norm(want)) return true;
      const control = inp.closest('[class*="control" i]');
      const single = control?.querySelector('[class*="single-value" i], [class*="singleValue" i]');
      return norm(single?.textContent) === norm(want);
    }, expected)
    // allow-failopen: unreadable DOM reports false, so the field stays unverified and is asked on Telegram.
    .catch(() => false);
}

async function closeMenu(input: Locator): Promise<void> {
  // allow-failopen: closing an already-closed or detached menu is a no-op.
  await input.press("Escape", { timeout: 2_000 }).catch(() => undefined);
  // allow-failopen: blur of a detached input is a no-op.
  await input.blur({ timeout: 2_000 }).catch(() => undefined);
}

/** Open a combobox with ArrowDown and list its fixed options; `[]` means free text or async autocomplete. */
export async function readComboboxOptions(page: Page, input: Locator): Promise<string[]> {
  await input.focus({ timeout: 2_000 });
  await input.press("ArrowDown", { timeout: 2_000 });
  const { menu } = await pollMenu(page, input, COMBOBOX_OPEN_WAIT_MS, (texts) => (texts.length > 0 ? 0 : -1));
  await closeMenu(input);
  return menu.texts.filter((t) => t.length > 0);
}

/** Choose the option whose text equals `option`, then verify the combobox shows it after blur. */
export async function chooseComboboxOption(page: Page, input: Locator, option: string): Promise<boolean> {
  const want = option.replace(/\s+/g, " ").trim().toLowerCase();
  await input.focus({ timeout: 5_000 });
  await input.press("ArrowDown", { timeout: 5_000 });
  const { menu, index } = await pollMenu(page, input, COMBOBOX_CHOOSE_WAIT_MS, (texts) =>
    texts.findIndex((t) => t.toLowerCase() === want),
  );
  if (index < 0) {
    await closeMenu(input);
    return false;
  }
  await menu.item(index).click({ timeout: 5_000 });
  await input.blur({ timeout: 2_000 });
  return comboboxShows(input, menu.texts[index]!);
}

/**
 * Type the first comma segment of `value`, wait for a suggestion `pickAutocompleteOption` accepts, click it,
 * and verify after blur. A combobox that never shows suggestions is treated as free text and gets the full value.
 */
export async function typeIntoCombobox(page: Page, input: Locator, value: string): Promise<boolean> {
  const query = value.split(",")[0]!.trim();
  if (!query) return false;
  await input.focus({ timeout: 5_000 });
  await input.pressSequentially(query, { delay: 25, timeout: 10_000 });
  const { menu, index, sawOptions } = await pollMenu(page, input, COMBOBOX_TYPE_WAIT_MS, (texts) => {
    const pick = pickAutocompleteOption(value, texts);
    return pick === null ? -1 : texts.indexOf(pick);
  });
  if (index >= 0) {
    await menu.item(index).click({ timeout: 5_000 });
    await input.blur({ timeout: 2_000 });
    return comboboxShows(input, menu.texts[index]!);
  }
  if (!sawOptions) {
    await input.fill(value, { timeout: 5_000 });
    await input.blur({ timeout: 2_000 });
    return comboboxShows(input, value);
  }
  await closeMenu(input);
  return false;
}
