/**
 * FounderOS - path rules for the PR evidence engine (./pr-evidence.ts)
 * ====================================================================
 * Pure helpers: which paths are tests, which are off limits to an executor, and a small glob
 * matcher for the contract scope (own implementation, no new dependency).
 */

export const norm = (p: string): string => (p.startsWith("./") ? p.slice(2) : p);

/** A path the engine will not reason about: absolute, empty, or containing a dot-dot segment. */
export function unsafePath(p: string): boolean {
  return p.startsWith("/") || p.split("/").some((seg) => seg === "" || seg === String.fromCharCode(46, 46));
}

const TEST_PATTERNS = [/^(tests?|__tests__)\//, /(^|\/)__tests__\//, /\.(test|spec)\.[cm]?[jt]sx?$/];
export const isTestPath = (p: string): boolean => TEST_PATTERNS.some((re) => re.test(p));

const PROTECTED_BASENAMES = [
  /^eslint\.config\./,
  /^\.eslintrc/,
  /^tsconfig(\..+)?\.json$/,
  /^vitest\.(config|workspace|setup)\./,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
];

/** Why an executor may not touch this path, or null when it is not protected. */
export function protectedReason(p: string): string | null {
  const lower = p.toLowerCase();
  if (lower.startsWith(".github/")) return "CI configuration";
  if (lower.startsWith("scripts/verify-")) return "a verification script";
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (PROTECTED_BASENAMES.some((re) => re.test(base))) return "lint, type, test or dependency configuration";
  return null;
}

/** Expand brace alternatives (a,b) into plain globs. Unbalanced braces are left literal. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open < 0) return [glob];
  let depth = 0;
  let close = -1;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [glob];
  const alternatives: string[] = [];
  let level = 0;
  let current = "";
  for (const c of glob.slice(open + 1, close)) {
    if (c === "{") level++;
    if (c === "}") level--;
    if (c === "," && level === 0) {
      alternatives.push(current);
      current = "";
    } else current += c;
  }
  alternatives.push(current);
  const pre = glob.slice(0, open);
  const post = glob.slice(close + 1);
  const out: string[] = [];
  for (const alt of alternatives) {
    for (const expanded of expandBraces(pre + alt + post)) out.push(expanded);
  }
  return out;
}

const REGEX_SPECIAL = ".+^" + String.fromCharCode(36) + "(){}|[]\\";

function globToRegExp(glob: string): RegExp {
  const g = glob.endsWith("/") ? glob + "*".repeat(2) : glob;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g.charAt(i);
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += REGEX_SPECIAL.indexOf(c) >= 0 ? "\\" + c : c;
  }
  return new RegExp("^" + re + String.fromCharCode(36));
}

/**
 * Repo-relative glob match. `*` stays inside a path segment, a double star crosses segments,
 * `?` is one non-slash character, `a,b` in braces is alternation, and a trailing slash means
 * "everything under this directory".
 */
export function globMatch(glob: string, path: string): boolean {
  const p = norm(path);
  return expandBraces(norm(glob)).some((g) => globToRegExp(g).test(p));
}

