import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Real GitHub REST / vitest JSON captured for PR #912 (trimmed). See tests/fixtures/pr-evidence. */
export function loadPrEvidenceFixture(name: string): unknown {
  const path = fileURLToPath(new URL("../fixtures/pr-evidence/" + name, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export const PR912_HEAD = "a9efb43c38650a9d4f4eadbd2e81fa79b7d235d0";
