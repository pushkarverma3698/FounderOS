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
 * CI runs this; the Python suite that exercises the overlay in a real browser
 * (mac-client/tests) is not in CI.
 */

import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, it, expect } from "vitest";

const OVERLAY_PATH = new URL("../../../mac-client/mac_client/overlay.js", import.meta.url);

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

  it("finds the overlay it is meant to scan", () => {
    // Otherwise a moved file would make every check above pass on nothing.
    expect(overlay).toContain("founderosDecision");
    expect(overlay).toContain("submit.onclick");
  });
});
