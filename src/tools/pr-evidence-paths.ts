/**
 * FounderOS - path rules for the PR evidence engine (./pr-evidence.ts)
 * ====================================================================
 * Pure helpers: which paths are tests and which are off limits to an executor. The protected
 * list and the glob matcher are the spec gate's own (./spec-gate.ts), so the spec gate that
 * approves a scope and the evidence engine that checks the built diff cannot disagree.
 */

import { PROTECTED_PATHS, globMatches } from "./spec-gate.js";

export const norm = (p: string): string => (p.startsWith("./") ? p.slice(2) : p);

/** A path the engine will not reason about: absolute, empty, or containing a dot-dot segment. */
export function unsafePath(p: string): boolean {
  return p.startsWith("/") || p.split("/").some((seg) => seg === "" || seg === String.fromCharCode(46, 46));
}

const TEST_PATTERNS = [/^(tests?|__tests__)\//, /(^|\/)__tests__\//, /\.(test|spec)\.[cm]?[jt]sx?$/];
export const isTestPath = (p: string): boolean => TEST_PATTERNS.some((re) => re.test(p));

/** True when the path is inside the contract scope (spec-gate glob rules). */
export const inScope = (scope: readonly string[], p: string): boolean => scope.some((g) => globMatches(g, p));

/**
 * Why an executor may not touch this path, or null when it is not protected. Lower-cased, so a
 * case-insensitive filesystem cannot smuggle `ESLint.config.js` past it. Slash-free patterns
 * (package.json, tsconfig*) also match by basename at any depth.
 */
export function protectedReason(p: string): string | null {
  const lower = p.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  for (const pattern of PROTECTED_PATHS) {
    if (globMatches(pattern, lower) || (!pattern.includes("/") && globMatches(pattern, base))) {
      return "a protected path (" + pattern + ")";
    }
  }
  return null;
}
