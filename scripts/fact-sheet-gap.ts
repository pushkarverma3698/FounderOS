/**
 * Fact-sheet gap report (READ ONLY)
 * =================================
 * Per profile: how many needs_you rows (last 14 days) have only fact-sheet-category questions open, so filling
 * the Mini App fact sheet could move them to auto. Prints counts and category names only, never a stored value.
 * Writes nothing. The classifier is unit-tested (tests/unit/jobhunt/fact-sheet-gap.test.ts).
 *
 *   node --import tsx/esm --env-file=.env scripts/fact-sheet-gap.ts [--profile <id>]
 */

import { closeDatabaseConnections } from "../src/db/client.js";
import { loadQuestionSources } from "../src/gateway/questions-data.js";
import { listProfiles } from "../src/tools/jobhunt/profile-config.js";
import { factGap, formatFactGap } from "../src/tools/jobhunt/fact-sheet-gap.js";

const flag = process.argv.indexOf("--profile");
const only = flag >= 0 ? process.argv[flag + 1] : undefined;

try {
  for (const p of listProfiles().filter((x) => !only || x.id === only)) {
    const sources = await loadQuestionSources(p.id, new Date());
    console.log(formatFactGap(p.id, factGap(sources)));
  }
} finally {
  await closeDatabaseConnections();
}
