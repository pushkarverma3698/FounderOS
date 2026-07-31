#!/usr/bin/env tsx
/** Ad-hoc verification: does cv_gaps read the real CV and produce a real report? */
import { cvGapsTool } from "../src/tools/jobhunt/gaps.js";
import { readFullCvText } from "../src/tools/career.js";

const cv = readFullCvText();
console.log("readFullCvText →", cv.ok ? `OK source=${cv.source} chars=${cv.text.length}` : `FAIL ${cv.error}`);
console.log("---- cv_gaps ----");
const res = await cvGapsTool.execute({});
console.log(res.success ? res.data : `ERROR: ${res.error}`);
