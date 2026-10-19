/**
 * apply-page-script: the inline Mini App script, run against a stub DOM ($0, no browser)
 * ======================================================================================
 *   1. Cancel succeeds → Prepare again appears at once (live on prod 2026-10-19 it stayed hidden: polling had stopped).
 */
import { describe, it, expect } from "vitest";
import { APPLY_PAGE_SCRIPT } from "../../../src/gateway/apply-page-script.js";

interface StubEl {
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  value: string;
  handlers: Record<string, Array<(e: unknown) => void>>;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  getAttribute(name: string): string | null;
}

function stubEl(attrs: Record<string, string> = {}): StubEl {
  return {
    hidden: false, disabled: false, textContent: "", value: "", handlers: {},
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); },
    getAttribute: (name) => attrs[name] ?? null,
  };
}

/** Runs the script with initData set; fetch answers status=ready, then cancel=200. */
function boot(): { el: (id: string) => StubEl; flush: () => Promise<void> } {
  const els = new Map<string, StubEl>();
  const el = (id: string): StubEl => { let e = els.get(id); if (!e) { e = stubEl(); els.set(id, e); } return e; };
  el("mini-again").hidden = true;
  el("mini-again-confirm").hidden = true;
  const main = stubEl({ "data-created": "1", "data-company": "Acme", "data-row": "row-1" });
  const document = {
    querySelector: (sel: string) => (sel === "main" ? main : null),
    querySelectorAll: () => [],
    getElementById: (id: string) => (id.startsWith("self") ? null : el(id)),
  };
  const fetch = (url: string) => {
    const body = url.endsWith("/cancel") ? { detail: "Cancelled." } : { state: "ready", detail: "Ready to submit." };
    return Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
  };
  const window = { Telegram: { WebApp: { initData: "signed", ready() {}, expand() {} } } };
  const location = { pathname: "/apply/row-1.1.sig" };
  const timers = { setTimeout: () => 0, clearTimeout: () => undefined };
  new Function("window", "document", "fetch", "location", "navigator", "setTimeout", "clearTimeout", APPLY_PAGE_SCRIPT)(
    window, document, fetch, location, {}, timers.setTimeout, timers.clearTimeout,
  );
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return { el, flush };
}

describe("apply page script", () => {
  it("shows Prepare again as soon as Cancel succeeds", async () => {
    const { el, flush } = boot();
    await flush();
    expect(el("mini-again").hidden).toBe(true); // ready: nothing to prepare again
    el("mini-cancel").handlers.click?.forEach((fn) => fn({}));
    await flush();
    expect(el("mini-status").textContent).toBe("Cancelled.");
    expect(el("mini-cancel").hidden).toBe(true);
    expect(el("mini-again").hidden).toBe(false);
  });
});
