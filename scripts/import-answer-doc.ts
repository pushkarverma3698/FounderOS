/**
 * Import a candidate's filled-in question document into their apply profile and dossier.
 *
 *   node --import tsx/esm scripts/import-answer-doc.ts <profileId> <file>            dry run: prints what it would write
 *   node --import tsx/esm scripts/import-answer-doc.ts <profileId> <file> --apply    saves through the answer store (backup first)
 *
 * Values print only on the dry run when --show-values is given, so the output is safe to paste.
 */
import { readFile } from "node:fs/promises";
import { importAnswerDoc, previewLines } from "../src/tools/jobhunt/answer-doc-apply.js";

const [profileId, file, ...flags] = process.argv.slice(2);
if (!profileId || !file) {
  console.error("usage: import-answer-doc.ts <profileId> <file> [--apply] [--show-values]");
  process.exit(2);
}
const apply = flags.includes("--apply");
const text = await readFile(file, "utf8");
const out = await importAnswerDoc(profileId, text, apply);
console.log(previewLines(out.patch, flags.includes("--show-values")).join("\n"));
if (!apply) {
  console.log("\nDry run. Nothing was written. Add --apply to save.");
} else if (out.saved === undefined) {
  console.log("\nNothing to write.");
} else if (out.saved.ok) {
  console.log(`\nSaved ${out.patch.writes.length} fields (backup kept).`);
} else {
  console.error(`\nNot saved: ${out.saved.reason}`);
  process.exit(1);
}
