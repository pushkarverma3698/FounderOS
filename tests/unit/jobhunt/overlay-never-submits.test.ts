/**
 * SUBMIT STAYS HUMAN, the overlay side (ADR-018).
 *
 * On 2026-08-24 `submit_application` clicked Submit before any approval existed.
 * The Mac client's overlay (mac-client/mac_client/overlay.js) is the one place
 * that presses an employer's own button, and it may do so only as the direct
 * consequence of the founder pressing the overlay's SUBMIT & NEXT. This parses
 * the real file with the TypeScript compiler (a proper AST, not a text search)
 * and requires that every call which acts on the employer's page (`.click()`,
 * `.submit()`, `.requestSubmit()`, `.dispatchEvent()`) sits lexically inside
 * the handler assigned to `submit.onclick`, and that there is exactly one.
 *
 * The same parse pins the other half of ADR-018: "applied" is reported from
 * exactly three places: a POSITIVE page signal (`if (successSignal())`), or the
 * founder's own press of YES on "Did the application go through?", or of
 * "I SUBMITTED IT MYSELF". A page that says nothing is never defaulted to applied.
 *
 * A form that navigates destroys the bar before it can report, so the host
 * (mac-client/mac_client/after_submit.py) puts the same question on the new page.
 * That path may ASK, never decide: the overlay tells its host only that SUBMIT was
 * pressed or that she answered NO, no handler is ever invoked by the overlay
 * itself, and the Python side has no way to write an outcome of its own.
 *
 * CI runs this; the Python suite that exercises the overlay in a real browser
 * (mac-client/tests) is not in CI.
 */

import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, it, expect } from "vitest";

const OVERLAY_PATH = new URL("../../../mac-client/mac_client/overlay.js", import.meta.url);
const AFTER_SUBMIT_PATH = new URL("../../../mac-client/mac_client/after_submit.py", import.meta.url);
const APPLY_PATH = new URL("../../../mac-client/mac_client/apply.py", import.meta.url);

/** Method calls that act on a page instead of reading it. */
const ACTING_METHODS: ReadonlySet<string> = new Set(["click", "submit", "requestSubmit", "dispatchEvent"]);

interface ActingCall {
  readonly method: string;
  readonly receiver: string;
  readonly insideHumanSubmitHandler: boolean;
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("overlay.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

/** `submit.onclick = async () => { ... }`: the founder's own press of SUBMIT & NEXT. */
function isHumanSubmitHandler(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const parent = node.parent;
  if (!ts.isBinaryExpression(parent) || parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const left = parent.left;
  return (
    ts.isPropertyAccessExpression(left) &&
    ts.isIdentifier(left.expression) &&
    left.expression.text === "submit" &&
    left.name.text === "onclick"
  );
}

function isInsideHumanSubmitHandler(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isHumanSubmitHandler(current)) return true;
  }
  return false;
}

function actingMethodOf(call: ts.CallExpression): { method: string; receiver: string } | null {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && ACTING_METHODS.has(callee.name.text)) {
    return { method: callee.name.text, receiver: callee.expression.getText() };
  }
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)) {
    const method = callee.argumentExpression.text;
    if (ACTING_METHODS.has(method)) return { method, receiver: callee.expression.getText() };
  }
  return null;
}

function actingCalls(source: string): ActingCall[] {
  const found: ActingCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const acting = actingMethodOf(node);
      if (acting) found.push({ ...acting, insideHumanSubmitHandler: isInsideHumanSubmitHandler(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return found;
}

/** `<name>.onclick = ...` handlers that are the founder's own explicit confirmation that it was sent. */
const HUMAN_CONFIRMATION_BUTTONS: ReadonlySet<string> = new Set(["yes", "mine"]);

/** Where each `founderosDecision("applied")` sits: the condition or button that guards it. */
function appliedRecordingOrigins(source: string): string[] {
  const origins: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "founderosDecision" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "applied"
    ) {
      origins.push(originOf(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return origins;
}

function originOf(call: ts.Node): string {
  let innermostCondition: string | null = null;
  for (let child: ts.Node = call, current = call.parent; current; child = current, current = current.parent) {
    if (ts.isIfStatement(current) && child === current.thenStatement) {
      const condition = current.expression.getText();
      if (condition === "successSignal()") return condition;
      innermostCondition ??= condition;
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isBinaryExpression(current.parent)) {
      const left = current.parent.left;
      if (ts.isPropertyAccessExpression(left) && left.name.text === "onclick" && ts.isIdentifier(left.expression)) {
        const button = left.expression.text;
        if (HUMAN_CONFIRMATION_BUTTONS.has(button)) return `${button}.onclick`;
      }
    }
  }
  return `UNGUARDED (under: ${innermostCondition ?? "nothing"})`;
}

/** The `<name>` of the nearest enclosing `<name>.onclick = ...` handler, if any. */
function enclosingButton(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isBinaryExpression(current.parent)) {
      const left = current.parent.left;
      if (ts.isPropertyAccessExpression(left) && left.name.text === "onclick" && ts.isIdentifier(left.expression)) {
        return left.expression.text;
      }
    }
  }
  return null;
}

interface HostEvent {
  readonly kind: string;
  readonly from: string;
}

/** Every `tellHost("<kind>")`: what the overlay tells its host, and the button handler it does so from. */
function hostEvents(source: string): HostEvent[] {
  const found: HostEvent[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "tellHost" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ kind: node.arguments[0].text, from: enclosingButton(node) ?? "NOT IN A BUTTON HANDLER" });
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return found;
}

/** Every `window.founderosEvent(...)` call, wherever it sits. */
function hostChannelCalls(source: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "founderosEvent"
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return count;
}

/** Handlers the overlay calls ITSELF (`yes.onclick()`): a way to answer for her. */
function invokedHandlers(source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "onclick") {
      found.push(node.expression.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return found;
}

const overlay = readFileSync(OVERLAY_PATH, "utf8");

describe("overlay.js presses an employer's button only for the founder", () => {
  it("has exactly one acting call, on the found submit element, inside the SUBMIT & NEXT handler", () => {
    expect(actingCalls(overlay)).toEqual([
      { method: "click", receiver: "target", insideHumanSubmitHandler: true },
    ]);
  });

  it("never submits a form by any other route", () => {
    const routes = actingCalls(overlay).filter((c) => c.method !== "click");
    expect(routes).toEqual([]);
  });

  // A guard that cannot fail proves nothing.
  it("notices a click in the SKIP handler, in a helper, and at the top level", () => {
    const bad = `(data) => {
      skip.onclick = async () => { document.querySelector("button").click(); };
      function findAndPress() { form["submit"](); }
      submit.onclick = async () => { target.click(); };
      form.requestSubmit();
    }`;
    expect(actingCalls(bad)).toEqual([
      { method: "click", receiver: 'document.querySelector("button")', insideHumanSubmitHandler: false },
      { method: "submit", receiver: "form", insideHumanSubmitHandler: false },
      { method: "click", receiver: "target", insideHumanSubmitHandler: true },
      { method: "requestSubmit", receiver: "form", insideHumanSubmitHandler: false },
    ]);
  });

  it("records applied only from a positive page signal or the founder's own YES", () => {
    expect(appliedRecordingOrigins(overlay).sort()).toEqual(["mine.onclick", "successSignal()", "yes.onclick"]);
  });

  it("notices applied being written because a timer ran out", () => {
    const bad = `(data) => {
      const poll = () => {
        if (successSignal()) { window.founderosDecision("applied"); return; }
        if (Date.now() - startTime > settleMs) { window.founderosDecision("applied"); return; }
      };
      skip.onclick = async () => { await window.founderosDecision("skipped"); };
    }`;
    expect(appliedRecordingOrigins(bad).sort()).toEqual([
      "UNGUARDED (under: Date.now() - startTime > settleMs)",
      "successSignal()",
    ]);
  });

  it("finds the overlay it is meant to scan", () => {
    // Otherwise a moved file would make every check above pass on nothing.
    expect(overlay).toContain("founderosDecision");
    expect(overlay).toContain("submit.onclick");
  });
});

describe("a page the form navigated away from: the host may ask, never decide", () => {
  it("tells its host only that SUBMIT was pressed and that she answered NO, each from its own button", () => {
    expect(hostEvents(overlay)).toEqual([
      { kind: "submit-attempted", from: "submit" },
      { kind: "answered-no", from: "no" },
    ]);
  });

  it("reaches the host through one helper, so no other call can smuggle an outcome through", () => {
    expect(hostChannelCalls(overlay)).toBe(1);
  });

  it("never answers for her by invoking a button handler itself", () => {
    expect(invokedHandlers(overlay)).toEqual([]);
  });

  // A guard that cannot fail proves nothing.
  it("notices an outcome sent as an event, and a handler pressed by the overlay", () => {
    const bad = `(data) => {
      skip.onclick = async () => { await tellHost("applied"); };
      tellHost("submit-attempted");
      if (data.ask) yes.onclick();
    }`;
    expect(hostEvents(bad)).toEqual([
      { kind: "applied", from: "skip" },
      { kind: "submit-attempted", from: "NOT IN A BUTTON HANDLER" },
    ]);
    expect(invokedHandlers(bad)).toEqual(["yes.onclick"]);
  });

  it("is carried out by a Python watcher that cannot reach the outcome store", () => {
    const watcher = readFileSync(AFTER_SUBMIT_PATH, "utf8");
    expect(watcher).toContain("class SubmitWatch");
    expect(watcher).not.toMatch(/\bledger\b/);
    expect(watcher).not.toMatch(/\.record\(/);
    expect(watcher).not.toMatch(/set_result/); // it may fail the job's future, never complete it
  });

  it("leaves apply.py writing an outcome from two places only: the expired-posting skip and the founder's decision", () => {
    const apply = readFileSync(APPLY_PATH, "utf8");
    const sites = [...apply.matchAll(/ledger\.record\(job\.id, ([\w.]+)/g)].map((m) => m[1]);
    expect(sites).toEqual(["ledger.SKIPPED", "outcome"]);
    expect(apply).not.toMatch(/ledger\.record\([^)]*(APPLIED|["']applied["'])/);
  });

  it("would notice the watcher recording a navigation as applied", () => {
    const bad = `ledger.record(job.id, ledger.APPLIED, company=job.company)`;
    expect(bad).toMatch(/ledger\.record\([^)]*(APPLIED|["']applied["'])/);
    expect(`from . import ledger`).toMatch(/\bledger\b/);
  });
});
