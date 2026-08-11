/**
 * .env.example ⇄ config schema parity.
 * =====================================
 * .env.example is the only description an operator gets of what this process
 * reads. Seven keys the config schema accepts were missing from it —
 * SKILL_SYNTHESIS_ENABLED (a security gate), JOBHUNT_SHEET_ID and
 * GOOGLE_SHEETS_CREDENTIALS_PATH (without which the jobhunt lane has nowhere to
 * publish and looks identical to an empty market), HALT_FLAG_PATH (the kill
 * switch), LLM_CACHE_*, WEB_GATEWAY_PORT. Undocumented knobs are how a box ends
 * up configured by folklore.
 *
 * Parses the real zod schema out of src/core/config.ts rather than importing it,
 * because importing config.ts validates the environment and would need secrets.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Top-level `KEY: z.…` entries of the env schema in src/core/config.ts. */
function schemaKeys(): string[] {
  const source = read("../../../src/core/config.ts");
  return [...new Set([...source.matchAll(/^ {2}([A-Z][A-Z0-9_]{2,}):\s*z\./gm)].map((m) => m[1]!))];
}

/** Every key .env.example documents, commented-out entries included. */
function documentedKeys(): Set<string> {
  const source = read("../../../.env.example");
  return new Set([...source.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
}

describe(".env.example parity", () => {
  it("documents every variable the config schema reads", () => {
    const documented = documentedKeys();
    const undocumented = schemaKeys().filter((k) => !documented.has(k));
    expect(
      undocumented,
      `read by src/core/config.ts but absent from .env.example: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("parses a non-trivial number of keys from both files", () => {
    // Guards the regexes above: a parser that silently matches nothing would
    // make the parity assertion vacuously true.
    expect(schemaKeys().length).toBeGreaterThan(50);
    expect(documentedKeys().size).toBeGreaterThan(100);
  });
});
