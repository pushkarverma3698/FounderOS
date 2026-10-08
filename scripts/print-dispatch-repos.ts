/**
 * Prints the repositories the dispatch loop may work on, one owner/repo per line and nothing else.
 *
 * The bash daemons (deploy/agent-dispatch, deploy/onboard-repo.sh) used to carry their own copy of this list,
 * DEFAULT_REPOS, and a CI test held the two equal. They read this instead, so there is one list to edit:
 * DISPATCH_REPO_ALLOWLIST in src/tools/dispatch-repos.ts. See deploy/lib/dispatch-repos.sh.
 */
import { DISPATCH_REPO_ALLOWLIST } from "../src/tools/dispatch-repos.js";

process.stdout.write(`${DISPATCH_REPO_ALLOWLIST.join("\n")}\n`);
