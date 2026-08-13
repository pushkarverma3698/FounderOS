/**
 * Evolution Engine — locate the repository root from inside src/ OR dist/.
 * =========================================================================
 * This exists because of a measured production defect, not for tidiness.
 *
 * The old acting loop reached the analyzers via a dynamic import from
 * `src/evolution/audit-sweep.ts` to `../../scripts/audit-self.js`, and
 * `scripts/audit-self.ts` derived its root as `dirname(import.meta.url)/..`.
 * That is correct under `tsx` from source, and wrong once compiled: prod runs
 * `node dist/src/index.js` (package.json `start`, deploy/founderos.service:42),
 * so the import resolved to `/opt/founderos/dist/scripts/audit-self.js` and the
 * root became `/opt/founderos/dist`. From there:
 *
 *   - `collectSourceFiles(root, "src")` walked `dist/src`, which holds only
 *     `.js` and `.d.ts` — both filtered out — so it collected 0 source files;
 *   - `collectDependencies(root)` read `dist/package.json`, which the build
 *     never emits (`tsc` outDir only), and threw ENOENT.
 *
 * The throw escaped `runSelfAudit()` into the sweep's catch, which logged
 * "non-fatal" and sent nothing. The 3-day self-audit therefore delivered
 * nothing on prod, silently, every time it fired.
 *
 * NOT VERIFIED against the live box: this container has no ssh, no key and no
 * route to the VPS, so the claim above is derived from the deployed artifacts
 * (package.json `start`, deploy/founderos.service, tsconfig `outDir`) and
 * reproduced against this checkout's `dist/`, not observed in prod journald.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A repo root is the nearest ancestor holding BOTH package.json and a src/ directory. */
function isRepoRoot(dir: string): boolean {
  return existsSync(join(dir, "package.json")) && existsSync(join(dir, "src"));
}

/**
 * Walk up from `startDir` to the repository root. Correct from `src/evolution`
 * (tsx) and from `dist/src/evolution` (compiled), because `dist/` has no
 * package.json and is therefore skipped rather than mistaken for the root.
 *
 * @throws if no ancestor qualifies — a self-audit that cannot find the tree it
 * audits must fail loudly. Returning a wrong-but-plausible path is what produced
 * the silent zero-findings run this module documents.
 */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);

  for (;;) {
    if (isRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Cannot locate repository root above ${startDir} (looked for a directory containing both package.json and src/)`,
      );
    }
    dir = parent;
  }
}

/** The repository root for the running process, resolved from this module's location. */
export function repoRoot(): string {
  return findRepoRoot(dirname(fileURLToPath(import.meta.url)));
}
