/**
 * FounderOS — Accessibility Snapshot
 * ==================================
 * Turns a page into the list of interactive elements the agent may act on.
 *
 * The agent addresses elements by `ref`, never by CSS selector. Selectors break
 * silently when a page reflows and can resolve to the wrong node; a ref that no
 * longer exists fails loudly and forces a fresh snapshot.
 *
 * Split deliberately in two:
 *   - `PAGE_SCRIPT` runs inside the browser and only reads the DOM.
 *   - `normalizeSnapshot` is pure and unit-tested — filtering, naming, redaction
 *     and bounds all live here, where they can be reasoned about at $0.
 */

import type { Ref } from "./types.js";

/** Raw shape the in-page script returns, before normalisation. */
export interface RawElement {
  role: string;
  name: string;
  visible: boolean;
  disabled: boolean;
  value?: string;
  secure?: boolean;
  submits?: boolean;
}

const MAX_ELEMENTS = 200;
const MAX_NAME_CHARS = 120;

/**
 * Normalise raw DOM descriptors into the agent-facing snapshot.
 *
 * Bounded on purpose: a page with thousands of controls would otherwise consume
 * the whole model context and crowd out the actual task.
 */
export function normalizeSnapshot(raws: RawElement[]): Ref[] {
  const out: Ref[] = [];

  for (const el of raws) {
    if (out.length >= MAX_ELEMENTS) break;
    if (!el.visible) continue;

    const name = tidy(el.name);
    if (!name) continue; // an element with no accessible name is unreasonable-about

    const ref: Ref = {
      ref: `ref_${out.length + 1}`,
      role: el.role,
      name,
    };

    // Never surface the contents of a password or credential field, even to the
    // model. The agent needs to know the field EXISTS, never what is in it.
    if (el.secure) {
      ref.secure = true;
    } else if (el.value != null && el.value !== "") {
      ref.value = truncate(el.value, MAX_NAME_CHARS);
    }

    if (el.submits) ref.submits = true;
    if (el.disabled) ref.disabled = true;

    out.push(ref);
  }

  return out;
}

function tidy(raw: string): string {
  return truncate(raw.replace(/\s+/g, " ").trim(), MAX_NAME_CHARS);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Read-only DOM walk, evaluated inside the page.
 *
 * Kept as a string because the kernel's tsconfig has no DOM lib — the same
 * reason `browser-playwright.ts` uses string-based `page.evaluate`.
 */
export const PAGE_SCRIPT = `(() => {
  const SEL = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [contenteditable="true"]';
  const els = Array.from(document.querySelectorAll(SEL));
  const out = [];
  for (const el of els) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible =
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) > 0.05 &&
      rect.width > 0 && rect.height > 0;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const explicitRole = el.getAttribute('role');
    const role = explicitRole
      || (tag === 'a' ? 'link'
      : tag === 'button' ? 'button'
      : tag === 'select' ? 'combobox'
      : tag === 'textarea' ? 'textbox'
      : tag === 'input' ? (type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' || type === 'button' ? 'button' : 'textbox')
      : tag);

    const name = (
      el.getAttribute('aria-label') ||
      (el.getAttribute('aria-labelledby') && (document.getElementById(el.getAttribute('aria-labelledby'))||{}).innerText) ||
      el.innerText ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('value') ||
      el.getAttribute('name') ||
      ''
    );

    const secure = type === 'password' || /pass|cvv|cvc|card|ssn|secret/i.test(el.getAttribute('name') || el.getAttribute('autocomplete') || '');
    const submits = type === 'submit' || (tag === 'button' && (el.getAttribute('type') || 'submit') === 'submit' && !!el.closest('form'));

    out.push({
      role: String(role),
      name: String(name),
      visible: visible,
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      value: el.value != null ? String(el.value) : undefined,
      secure: secure,
      submits: submits,
    });
  }
  return JSON.stringify(out);
})()`;
