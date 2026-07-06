/**
 * FounderOS — Test-Integrity Check (compile/CI-time anti-gaming guard)
 * =====================================================================
 * CLAUDE.md rule #25: a test written by the same pass that wrote the fix it
 * tests can be wrong in the fix's favor without anyone noticing. This module
 * mechanically detects the concrete shapes that class of bug takes:
 *   - tautological assertions (`expect(true).toBe(true)`)
 *   - a test whose only assertions are weak (`toBeDefined`/`toBeTruthy`/…)
 *   - empty test bodies
 *   - `.only` left in (silently disables the rest of the suite — no escape hatch)
 *   - `.skip` with no recorded reason
 *   - mocking the exact unit a test file claims to test (nothing real runs)
 *
 * Pure: source text in → findings out. No git, no fs — `verify-test-integrity.ts`
 * supplies the file list and file contents; this stays unit-testable with plain
 * strings (see tests/unit/infra/test-integrity-check.test.ts).
 *
 * Escape hatch: `// test-integrity-ignore: <non-empty reason>` on the line
 * directly above the flagged construct. `.only` never honors it — leaving the
 * rest of a suite disabled is never legitimate to merge.
 */

import ts from "typescript";

export type FindingRule =
  | "TAUTOLOGY"
  | "SOLE-WEAK-ASSERTION"
  | "EMPTY-BODY"
  | "ONLY-LEFT-IN"
  | "UNEXPLAINED-SKIP"
  | "SELF-MOCK";

export interface Finding {
  file: string;
  line: number;
  rule: FindingRule;
  severity: "error";
  message: string;
}

const TEST_FN_NAMES = new Set(["it", "test"]);
const SUITE_FN_NAMES = new Set(["it", "test", "describe"]);

const WEAK_MATCHERS = new Set(["toBeDefined", "toBeTruthy", "toBeFalsy", "toBeNull", "toBeUndefined", "toBeNaN"]);

interface SuiteCallInfo {
  base: string;
  modifier?: string;
}

/** `it`/`test`/`describe`, optionally with a `.only`/`.skip`/`.each` modifier. */
function suiteCallInfo(expr: ts.Expression): SuiteCallInfo | undefined {
  if (ts.isIdentifier(expr)) {
    return SUITE_FN_NAMES.has(expr.text) ? { base: expr.text } : undefined;
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const base = expr.expression.text;
    if (SUITE_FN_NAMES.has(base)) return { base, modifier: expr.name.text };
  }
  return undefined;
}

interface MatcherCallInfo {
  matcher: string;
  expectArg?: ts.Expression;
  matcherArg?: ts.Expression;
}

/** Recognizes `expect(x)[.not][.resolves]….matcher(y)` chains, any depth of property access. */
function matchExpectCall(node: ts.CallExpression): MatcherCallInfo | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const matcher = node.expression.name.text;
  let cur: ts.Expression = node.expression.expression;
  while (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
  if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === "expect") {
    return { matcher, expectArg: cur.arguments[0], matcherArg: node.arguments[0] };
  }
  return undefined;
}

function isBooleanLiteral(expr: ts.Expression | undefined): boolean | undefined {
  if (!expr) return undefined;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Non-empty `// test-integrity-ignore: <reason>` on the line directly above `node`. */
function escapeHatchReason(sourceFile: ts.SourceFile, lines: string[], node: ts.Node): string {
  const line = lineOf(sourceFile, node);
  const prevLine = lines[line - 2] ?? "";
  const match = /test-integrity-ignore:\s*(.*)$/.exec(prevLine);
  return match?.[1]?.trim() ?? "";
}

function baseTestName(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.(test|spec)\.tsx?$/, "");
}

function mockedModuleBaseName(literal: string): string {
  const base = literal.split("/").pop() ?? literal;
  return base.replace(/\.(js|ts|jsx|tsx)$/, "");
}

/**
 * Walk a test-body callback and collect every `expect(...)….matcher(...)` call
 * inside it, WITHOUT descending into a nested `it`/`test` block (those are
 * checked independently as their own suite calls).
 */
function collectMatcherCalls(node: ts.Node): MatcherCallInfo[] {
  const found: MatcherCallInfo[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const nested = suiteCallInfo(n.expression);
      if (nested && TEST_FN_NAMES.has(nested.base)) return; // handled by its own top-level visit
      const matcherCall = matchExpectCall(n);
      if (matcherCall) found.push(matcherCall);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
  return found;
}

function checkTestBody(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  lines: string[],
  filePath: string,
  findings: Finding[],
): void {
  const callback = call.arguments[call.arguments.length - 1];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;

  const body = callback.body;
  if (ts.isBlock(body)) {
    const meaningful = body.statements.filter((s) => !ts.isEmptyStatement(s));
    if (meaningful.length === 0) {
      if (!escapeHatchReason(sourceFile, lines, call)) {
        findings.push({
          file: filePath,
          line: lineOf(sourceFile, call),
          rule: "EMPTY-BODY",
          severity: "error",
          message: "Test body is empty — asserts nothing.",
        });
      }
      return;
    }
  }

  const matcherCalls = collectMatcherCalls(body);
  if (matcherCalls.length === 0) return; // no expect() calls — out of scope for this check

  for (const m of matcherCalls) {
    if (m.matcher !== "toBe") continue;
    const expectBool = isBooleanLiteral(m.expectArg);
    const matcherBool = isBooleanLiteral(m.matcherArg);
    if (expectBool !== undefined && expectBool === matcherBool) {
      if (!escapeHatchReason(sourceFile, lines, call)) {
        findings.push({
          file: filePath,
          line: lineOf(sourceFile, call),
          rule: "TAUTOLOGY",
          severity: "error",
          message: `expect(${expectBool}).toBe(${expectBool}) is not a real assertion.`,
        });
      }
    }
  }

  const allWeak = matcherCalls.every((m) => WEAK_MATCHERS.has(m.matcher));
  if (allWeak && !escapeHatchReason(sourceFile, lines, call)) {
    findings.push({
      file: filePath,
      line: lineOf(sourceFile, call),
      rule: "SOLE-WEAK-ASSERTION",
      severity: "error",
      message: `Only weak assertion(s) in this test (${[...new Set(matcherCalls.map((m) => m.matcher))].join(", ")}) — nothing specific is verified.`,
    });
  }
}

function checkSelfMock(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  lines: string[],
  filePath: string,
  findings: Finding[],
): void {
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  const { expression: obj, name } = call.expression;
  if (!ts.isIdentifier(obj) || name.text !== "mock") return;
  if (obj.text !== "vi" && obj.text !== "jest") return;
  const arg = call.arguments[0];
  if (!arg || !ts.isStringLiteralLike(arg)) return;
  if (mockedModuleBaseName(arg.text) !== baseTestName(filePath)) return;
  if (escapeHatchReason(sourceFile, lines, call)) return;
  findings.push({
    file: filePath,
    line: lineOf(sourceFile, call),
    rule: "SELF-MOCK",
    severity: "error",
    message: `Mocks "${arg.text}" — the same module this test file is named for. Nothing real is exercised.`,
  });
}

/**
 * Analyze one test file's source and return every finding. Never throws on
 * malformed input — the TS parser recovers and reports what it can.
 */
export function analyzeTestSource(filePath: string, source: string): Finding[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true);
  const lines = source.split("\n");
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const info = suiteCallInfo(node.expression);
      if (info) {
        if (info.modifier === "only") {
          findings.push({
            file: filePath,
            line: lineOf(sourceFile, node),
            rule: "ONLY-LEFT-IN",
            severity: "error",
            message: `${info.base}.only(...) disables the rest of the suite — never allowed, no escape hatch.`,
          });
        } else if (info.modifier === "skip") {
          const reason = escapeHatchReason(sourceFile, lines, node);
          if (!reason) {
            findings.push({
              file: filePath,
              line: lineOf(sourceFile, node),
              rule: "UNEXPLAINED-SKIP",
              severity: "error",
              message: `${info.base}.skip(...) needs a "// test-integrity-ignore: <reason>" comment directly above.`,
            });
          }
        }
        if (TEST_FN_NAMES.has(info.base)) {
          checkTestBody(node, sourceFile, lines, filePath, findings);
        }
      }
      checkSelfMock(node, sourceFile, lines, filePath, findings);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}
