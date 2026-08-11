/**
 * FounderOS — runtime asset verification
 * ======================================
 * Loads every non-code file the running system depends on THROUGH THE BUILT
 * OUTPUT in `dist/`, not through the source tree.
 *
 * Why this exists: on 2026-08-02 the IND sponsor register stopped resolving in
 * production. `sponsor-registry.ts` counted three directories up from its own
 * file to find the repo root — correct for `src/tools/jobhunt/…`, wrong for the
 * `dist/src/tools/jobhunt/…` that tsc actually emits. Screening threw ENOENT on
 * every posting for four days and cost ~$0.77 of Apify spend for zero results.
 *
 * The entire unit suite passed throughout, because `tsx` runs the source tree
 * where the arithmetic was right. `pnpm lint`, `pnpm test`, `verify:wiring` and
 * `verify:arch` all agreed the code was fine. Nothing in the gate ever executed
 * the built artefact, so nothing could have caught it.
 *
 * This step closes that gap: it is the only check that runs against what the
 * VPS actually starts. Add an entry to ASSETS whenever a module resolves a data
 * file at runtime.
 *
 *   pnpm verify:runtime-assets      (runs inside `pnpm gate`, after the build)
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface AssetCheck {
  /** What breaks if this asset does not resolve, in founder-facing terms. */
  readonly name: string;
  /** Module path inside dist/ that owns the resolution. */
  readonly module: string;
  /** Load it exactly as production would, and assert the contents are usable. */
  readonly check: (mod: Record<string, unknown>) => string;
}

const ASSETS: readonly AssetCheck[] = [
  {
    name: "IND recognised-sponsor register",
    module: "dist/src/tools/jobhunt/sponsor-registry.js",
    check: (mod) => {
      const path = (mod["registerPathFrom"] as () => string)();
      const getRegister = mod["getSponsorRegister"] as () => { index: Map<string, unknown> };
      const register = getRegister();
      // A register that loads but parses thin is the same outage wearing a
      // different mask: every company reads `not-sponsor` and the whole
      // reachable market is silently rejected.
      if (register.index.size < 12_000) {
        throw new Error(
          `parsed only ${register.index.size} entries from ${path} (expected >12,000). ` +
            `Screening against a thin register rejects real employers.`,
        );
      }
      return `${register.index.size.toLocaleString()} entries from ${path}`;
    },
  },
  {
    name: "Free ATS board registry",
    module: "dist/src/tools/jobhunt/free-boards.js",
    check: (mod) => {
      const path = (mod["boardsPathFrom"] as () => string)();
      const getBoards = mod["getFreeBoards"] as () => readonly unknown[];
      // `getFreeBoards` already throws below MIN_EXPECTED_BOARDS. Calling it here
      // is the whole check: it proves the CSV resolves from dist/ and parses to a
      // usable registry, which is exactly what the sponsor register failed to do
      // for four days while every unit test passed.
      const boards = getBoards();
      return `${boards.length} boards from ${path}`;
    },
  },
];

async function main(): Promise<void> {
  const root = process.cwd();

  if (!existsSync(resolve(root, "dist"))) {
    console.error("✗ dist/ not found — run `pnpm build` first.");
    process.exit(1);
  }

  let failed = 0;

  for (const asset of ASSETS) {
    const abs = resolve(root, asset.module);

    if (!existsSync(abs)) {
      console.error(`✗ ${asset.name}: built module missing at ${asset.module}`);
      failed += 1;
      continue;
    }

    try {
      const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
      console.log(`✓ ${asset.name}: ${asset.check(mod)}`);
    } catch (err) {
      console.error(`✗ ${asset.name}: ${(err as Error).message}`);
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(
      `\n${failed} runtime asset(s) unresolvable in the BUILT output. ` +
        `Production would fail on these even though the source tree works.`,
    );
    process.exit(1);
  }

  console.log(`\nAll ${ASSETS.length} runtime asset(s) resolve from dist/.`);
}

await main();
